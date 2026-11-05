// Codex quota analysis uses the backend's canonical per-request cost and the
// account-level quota observations captured from Codex response headers.
// Current Codex headers describe the whole account, not a model-specific pool,
// so every account/window is reported exactly once. Per-model token, cost and
// TPS details are nested inside that shared account window.
export function eventCost(e) {
  return Number.isFinite(e?.cost) ? e.cost : null;
}

export function costs(events) {
  let usd = 0;
  let priced = 0;
  for (const e of events) {
    const value = eventCost(e);
    if (value !== null) {
      usd += value;
      priced++;
    }
  }
  return { usd: priced ? usd : null, priced, unpriced: events.length - priced };
}

const modelOf = (e) => e.response_model || e.model || "unknown";
const tierOf = (e) => e.service_tier || "default";

function modelBreakdown(events) {
  const map = new Map();
  for (const e of events) {
    const model = modelOf(e);
    if (!map.has(model)) {
      map.set(model, {
        model, requests: 0, input: 0, output: 0, cache: 0, reasoning: 0,
        cost: 0, priced: 0, unpriced: 0,
      });
    }
    const row = map.get(model);
    row.requests++;
    row.input += e.input || 0;
    row.output += e.output || 0;
    row.cache += e.cache || 0;
    row.reasoning += e.reasoning || 0;
    if (Number.isFinite(e.cost)) {
      row.cost += e.cost;
      row.priced++;
    } else {
      row.unpriced++;
    }
  }
  return [...map.values()]
    .map((row) => ({ ...row, cost: row.priced ? row.cost : null }))
    .sort((a, b) => b.input + b.output - (a.input + a.output));
}

// No idle/account-wide deltas are charged to CPA. Only tightly adjacent,
// serial CPA executions in the same reset cycle form calibration samples.
// External activity DURING such executions remains intrinsically unknowable.
export function estimateQuotas(events, now = Date.now() / 1000) {
  const accounts = new Map();
  let missingAccount = 0;
  for (const e of events) {
    if (e.provider?.toLowerCase() !== "codex") continue;
    if (!e.account) {
      missingAccount++;
      continue;
    }
    if (!accounts.has(e.account)) accounts.set(e.account, []);
    accounts.get(e.account).push(e);
  }
  return {
    missingAccount,
    accounts: [...accounts].map(([account, unsorted]) => {
      const records = [...unsorted].sort((a, b) => a.ts - b.ts);
      const overlapping = new Set();
      let runningEnd = 0;
      let running = null;
      for (const e of records) {
        const end = e.ts + e.latency_ms / 1000;
        if (running && e.ts < runningEnd) {
          overlapping.add(e);
          overlapping.add(running);
        }
        if (Number.isFinite(end) && end > runningEnd) {
          runningEnd = end;
          running = e;
        }
      }
      const result = { account, plan: "", requests: records.length, windows: {} };
      for (const [key, seconds] of [["five_hour", 18000], ["week", 604800]]) {
        let previous = null;
        let maxEnd = 0;
        let latest = null;
        const valid = [];
        const history = [];
        for (const e of records) {
          const q = e.quota?.[key];
          const end = e.ts + e.latency_ms / 1000;
          const cost = eventCost(e);
          const overlap = overlapping.has(e) || !Number.isFinite(end) || e.ts < maxEnd;
          if (Number.isFinite(end)) maxEnd = Math.max(maxEnd, end);
          if (!q || !Number.isFinite(e.observed_ts) || e.observed_ts <= 0 ||
              !Number.isFinite(q.used_percent) || q.used_percent < 0 || q.used_percent > 100 ||
              !Number.isFinite(q.reset_at) || q.reset_at <= e.observed_ts) {
            previous = null;
            continue;
          }
          history.push({
            ts: e.ts,
            observedAt: e.observed_ts,
            usedPercent: q.used_percent,
            remainingPercent: 100 - q.used_percent,
            resetAt: q.reset_at,
            model: modelOf(e),
            tier: tierOf(e),
          });
          if (!latest || e.observed_ts > latest.observed_ts) latest = e;
          const prevQ = previous?.quota?.[key];
          const prevEnd = previous ? previous.ts + previous.latency_ms / 1000 : 0;
          const delta = prevQ ? q.used_percent - prevQ.used_percent : -1;
          // Header timing can precede request completion; bounded differences
          // remain observations, not provable per-request debit measurements.
          const eligible = previous && !overlap && !e.failed && !previous.failed &&
            e.latency_ms > 0 && previous.latency_ms > 0 && cost > 0 && eventCost(previous) > 0 &&
            e.ts >= prevEnd && e.ts - prevEnd <= 5 &&
            e.observed_ts > previous.observed_ts &&
            e.observed_ts - end >= -5 && e.observed_ts - end <= 60 &&
            Math.abs(q.reset_at - prevQ.reset_at) <= 60 &&
            e.observed_ts < prevQ.reset_at && delta >= 0;
          if (eligible) valid.push({ e, delta, cost });
          previous = overlap ? null : e;
        }
        if (!latest) {
          result.windows[key] = null;
          continue;
        }
        const q = latest.quota[key];
        const active = q.reset_at > now;
        // Only the latest reset cycle can calibrate the current window. A new
        // cycle starts from a fresh baseline instead of carrying old deltas.
        const currentValid = valid.filter((s) =>
          Math.abs(s.e.quota[key].reset_at - q.reset_at) <= 60,
        );
        let observed = 0;
        let sampleCost = 0;
        let sampleTokens = 0;
        for (const s of currentValid) {
          observed += s.delta;
          sampleCost += s.cost;
          sampleTokens += (s.e.input || 0) + (s.e.output || 0);
        }
        const samples = currentValid.length;
        const excluded = records.length - samples;
        const coefficient = active && samples >= 2 && observed > 0 && sampleCost > 0
          ? observed / sampleCost
          : null;
        const windowStart = q.reset_at - seconds;
        const current = records.filter((e) =>
          e.ts >= windowStart && e.ts <= now && !e.failed,
        );
        const spend = costs(current);
        const fullUSD = coefficient ? 100 / coefficient : null;
        const fullTokens = coefficient ? sampleTokens * 100 / observed : null;
        result.plan = latest.quota.plan || result.plan;
        result.windows[key] = {
          active,
          resetAt: q.reset_at,
          observedAt: latest.observed_ts,
          usedPercent: q.used_percent,
          remainingPercent: active ? 100 - q.used_percent : null,
          observedPercent: observed,
          samples,
          excluded,
          models: modelBreakdown(current),
          sampleModels: [...new Set(currentValid.map((s) => modelOf(s.e)))],
          tiers: [...new Set(current.map(tierOf))].sort(),
          estimatedCPAPercent: coefficient && spend.usd !== null
            ? spend.usd * coefficient
            : null,
          fullUSD,
          remainingUSD: fullUSD !== null
            ? fullUSD * (100 - q.used_percent) / 100
            : null,
          fullTokens,
          remainingTokens: fullTokens !== null
            ? fullTokens * (100 - q.used_percent) / 100
            : null,
          windowUSD: active ? spend.usd : null,
          unpriced: spend.unpriced,
          coveredRequests: current.length,
          history: history.sort((a, b) => a.observedAt - b.observedAt),
        };
      }
      return result;
    }),
  };
}
