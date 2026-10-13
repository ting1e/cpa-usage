export const fmt = (n) => Number(n || 0).toLocaleString("zh-CN");
export const compact = (n) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n || 0);
export const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const formatDuration = (ms) =>
  Number.isFinite(ms) && ms > 0 ? `${(ms / 1000).toFixed(2)} s` : "—";
export const formatTPS = (tps) =>
  Number.isFinite(tps) && tps > 0 ? tps.toFixed(2) : "—";
export function requestTPS(e) {
  const latency = e.latency_ms;
  const ttft = e.ttft_ms ?? 0;
  if (
    e.failed || !Number.isFinite(e.output) || e.output <= 0 ||
    !Number.isFinite(latency) || latency <= 0 ||
    !Number.isFinite(ttft) || ttft < 0 || ttft >= latency
  ) return null;
  const tps = e.output * 1000 / (latency - ttft);
  return Number.isFinite(tps) ? tps : null;
}
export function summarize(events) {
  const s = {
    n: 0, input: 0, output: 0, cache: 0, reasoning: 0, fail: 0,
    latencySamples: 0, latencyTotalMs: 0, ttftSamples: 0, ttftTotalMs: 0,
    tpsSamples: 0, tpsOutput: 0, tpsDurationMs: 0,
  };
  for (const e of events) {
    s.n++;
    s.input += e.input;
    s.output += e.output;
    s.cache += e.cache;
    s.reasoning += e.reasoning;
    s.fail += Number(e.failed);
    if (Number.isFinite(e.latency_ms) && e.latency_ms > 0) {
      s.latencySamples++;
      s.latencyTotalMs += e.latency_ms;
      if (Number.isFinite(e.ttft_ms) && e.ttft_ms > 0 && e.ttft_ms <= e.latency_ms) {
        s.ttftSamples++;
        s.ttftTotalMs += e.ttft_ms;
      }
    }
    if (requestTPS(e) !== null) {
      s.tpsSamples++;
      s.tpsOutput += e.output;
      s.tpsDurationMs += e.latency_ms - (e.ttft_ms ?? 0);
    }
  }
  return {
    ...s,
    avgLatencyMs: s.latencySamples ? s.latencyTotalMs / s.latencySamples : null,
    avgTTFTMs: s.ttftSamples ? s.ttftTotalMs / s.ttftSamples : null,
    tps: s.tpsSamples ? s.tpsOutput * 1000 / s.tpsDurationMs : null,
  };
}
export function groups(events, key) {
  const m = new Map();
  for (const e of events) {
    if (!m.has(e[key])) m.set(e[key], []);
    m.get(e[key]).push(e);
  }
  return [...m]
    .map(([name, evs]) => ({ name, ...summarize(evs) }))
    .sort((a, b) => b.input + b.output - (a.input + a.output));
}
export function trend(events, bucket) {
  const map = new Map();
  for (const e of events) {
    const d = new Date(e.ts * 1000),
      label =
        bucket === "month"
          ? dateKey(d).slice(0, 7)
          : bucket === "hour"
            ? `${dateKey(d)} ${String(d.getHours()).padStart(2, "0")}:00`
            : dateKey(d);
    if (!map.has(label))
      map.set(label, { label, cache: 0, net: 0, output: 0, requests: 0 });
    const b = map.get(label);
    b.cache += e.cache;
    b.net += Math.max(0, e.input - e.cache);
    b.output += e.output;
    b.requests++;
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}
