// Standard short-context text API prices, USD / 1M tokens.
// Source: https://developers.openai.com/api/docs/pricing (checked 2026-10-13).
// Explicit model matches only; aliases/unknown models require user prices.
export const priceSource = "https://developers.openai.com/api/docs/pricing";
export const defaultPrices = {
  "gpt-6-astra": { input: 10, cache: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cache: 0.1, output: 10 },
  "gpt-6-sol": { input: 2, cache: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cache: 0.01, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cache: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cache: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cache: 0.02, output: 1.2 },
  "gpt-5.5": { input: 5, cache: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cache: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cache: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cache: 0.02, output: 1.25 },
  "gpt-5.3-codex": { input: 1.75, cache: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cache: 0.175, output: 14 },
  "gpt-5.1": { input: 1.25, cache: 0.125, output: 10 },
};
export const formatUSD = (value) => Number.isFinite(value)
  ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : "—";
export function validatePrices(prices) {
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) throw Error("价格表必须是 JSON 对象");
  for (const [model, p] of Object.entries(prices)) {
    if (!model.trim() || !p || ![p.input, p.cache, p.output].every((n) => Number.isFinite(n) && n >= 0)) {
      throw Error(`模型 ${model} 的 input、cache、output 必须是非负数字`);
    }
  }
  return prices;
}
export function eventCost(e, prices = defaultPrices) {
  const p = prices[e.response_model || e.model];
  if (!p || ![p.input, p.cache, p.output].every((n) => Number.isFinite(n) && n >= 0) ||
      ![e.input, e.cache, e.output].every((n) => Number.isFinite(n) && n >= 0) || e.cache > e.input) return null;
  return ((e.input - e.cache) * p.input + e.cache * p.cache + e.output * p.output) / 1e6;
}
export function costs(events, prices) {
  let usd = 0, priced = 0;
  for (const e of events) {
    const value = eventCost(e, prices);
    if (value !== null) { usd += value; priced++; }
  }
  return { usd: priced ? usd : null, priced, unpriced: events.length - priced };
}

// No idle/account-wide deltas are charged to CPA. Only tightly adjacent,
// serial CPA executions in the same reset cycle form calibration samples.
// External activity DURING such executions remains intrinsically unknowable.
export function estimateQuotas(events, prices = defaultPrices, now = Date.now() / 1000) {
  const accounts = new Map();
  let missingAccount = 0;
  for (const e of events) {
    if (e.provider?.toLowerCase() !== "codex") continue;
    if (!e.account) { missingAccount++; continue; }
    if (!accounts.has(e.account)) accounts.set(e.account, []);
    accounts.get(e.account).push(e);
  }
  return { missingAccount, accounts: [...accounts].map(([account, records]) => {
    records.sort((a, b) => a.ts - b.ts);
    const overlapping = new Set();
    let runningEnd = 0, running = null;
    for (const e of records) {
      const end = e.ts + e.latency_ms / 1000;
      if (running && e.ts < runningEnd) { overlapping.add(e); overlapping.add(running); }
      if (Number.isFinite(end) && end > runningEnd) { runningEnd = end; running = e; }
    }
    const result = { account, plan: "", requests: records.length, windows: {} };
    for (const [key, seconds] of [["five_hour", 18000], ["week", 604800]]) {
      let previous = null, maxEnd = 0, observed = 0, sampleCost = 0, sampleTokens = 0, samples = 0, excluded = 0;
      let latest = null, sampleModel = null, sampleTier = null;
      const valid = [];
      for (const e of records) {
        const q = e.quota?.[key];
        const end = e.ts + e.latency_ms / 1000;
        const cost = eventCost(e, prices);
        const overlap = overlapping.has(e) || !Number.isFinite(end) || e.ts < maxEnd;
        if (Number.isFinite(end)) maxEnd = Math.max(maxEnd, end);
        if (!q || !Number.isFinite(e.observed_ts) || e.observed_ts <= 0 ||
            !Number.isFinite(q.used_percent) || q.used_percent < 0 || q.used_percent > 100 ||
            !Number.isFinite(q.reset_at) || q.reset_at <= e.observed_ts) {
          previous = null; excluded++; continue;
        }
        if (!latest || e.observed_ts > latest.observed_ts) latest = e;
        const model = e.response_model || e.model, tier = e.service_tier || "default";
        const prevQ = previous?.quota?.[key];
        const prevEnd = previous ? previous.ts + previous.latency_ms / 1000 : 0;
        const delta = prevQ ? q.used_percent - prevQ.used_percent : -1;
        // Header timing can precede request completion; bounded differences
        // remain observations, not provable per-request debit measurements.
        const eligible = previous && !overlap && !e.failed && !previous.failed &&
          e.latency_ms > 0 && previous.latency_ms > 0 && cost > 0 &&
          e.ts >= prevEnd && e.ts - prevEnd <= 5 &&
          e.observed_ts > previous.observed_ts &&
          e.observed_ts - end >= -5 && e.observed_ts - end <= 60 &&
          Math.abs(q.reset_at - prevQ.reset_at) <= 60 &&
          e.observed_ts < prevQ.reset_at && delta >= 0 &&
          model === (previous.response_model || previous.model) &&
          tier === (previous.service_tier || "default");
        if (eligible) valid.push({ e, delta, cost, model, tier }); else excluded++;
        previous = overlap ? null : e;
      }
      if (!latest) { result.windows[key] = null; continue; }
      const q = latest.quota[key];
      const active = q.reset_at > now;
      // Learn only this account/model/tier in its latest reset cycle.
      sampleModel = latest.response_model || latest.model;
      sampleTier = latest.service_tier || "default";
      for (const s of valid) {
        if (Math.abs(s.e.quota[key].reset_at - q.reset_at) <= 60 &&
            s.model === sampleModel && s.tier === sampleTier) {
          observed += s.delta; sampleCost += s.cost; sampleTokens += s.e.input + s.e.output; samples++;
        }
      }
      const coefficient = active && samples >= 2 && observed > 0 && sampleCost > 0 ? observed / sampleCost : null;
      const windowStart = q.reset_at - seconds;
      const current = records.filter((e) => e.ts >= windowStart && e.ts <= now && !e.failed &&
        (e.response_model || e.model) === sampleModel && (e.service_tier || "default") === sampleTier);
      const spend = costs(current, prices);
      const fullUSD = coefficient ? 100 / coefficient : null;
      const fullTokens = coefficient ? sampleTokens * 100 / observed : null;
      result.plan = latest.quota.plan || result.plan;
      result.windows[key] = {
        active, resetAt: q.reset_at, observedAt: latest.observed_ts,
        usedPercent: q.used_percent, remainingPercent: active ? 100 - q.used_percent : null,
        observedPercent: observed, samples, excluded, model: sampleModel, tier: sampleTier,
        estimatedCPAPercent: coefficient && spend.usd !== null ? spend.usd * coefficient : null,
        fullUSD, remainingUSD: fullUSD !== null ? fullUSD * (100 - q.used_percent) / 100 : null,
        fullTokens, remainingTokens: fullTokens !== null ? fullTokens * (100 - q.used_percent) / 100 : null,
        windowUSD: active ? spend.usd : null, unpriced: spend.unpriced,
        coveredRequests: current.length,
      };
    }
    return result;
  }) };
}
