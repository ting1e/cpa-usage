import test from "node:test";
import assert from "node:assert/strict";
import { summarize, groups, trend, dateKey, money, formatDuration, formatTPS, requestTPS } from "./analytics.js";
const fixture = [
  {
    ts: new Date(2026, 0, 1, 12).getTime() / 1000,
    model: "a",
    key: "k",
    input: 100,
    cache: 60,
    output: 20,
    reasoning: 5,
    failed: false,
  },
  {
    ts: new Date(2026, 0, 1, 13).getTime() / 1000,
    model: "a",
    key: "k",
    input: 0,
    cache: 0,
    output: 0,
    reasoning: 0,
    failed: true,
  },
];
test("tokens are not double counted and zero-token failures are included", () => {
  const s = summarize(fixture);
  assert.equal(s.input + s.output, 120);
  assert.equal(s.n, 2);
  assert.equal(s.fail, 1);
});
test("grouping and trend use same total", () => {
  assert.equal(groups(fixture, "model")[0].n, 2);
  const b = trend(fixture, "day")[0];
  assert.equal(b.cache + b.net + b.output, 120);
});
test("model statistics use the response model while keeping the requested alias", () => {
  const events = [
    { ...fixture[0], model: "my-alias", response_model: "gpt-6.1-sol" },
    { ...fixture[0], model: "my-alias", response_model: "gpt-6.1-sol" },
    { ...fixture[0], model: "gpt-6-luna", response_model: "gpt-6-luna" },
  ];
  const rows = groups(events, "model");
  assert.equal(rows.find((r) => r.name === "gpt-6.1-sol").n, 2);
  assert.equal(rows.find((r) => r.name === "gpt-6-luna").n, 1);
  assert.equal(events[0].model, "my-alias");
});
test("local date does not use UTC slicing", () =>
  assert.equal(dateKey(new Date(2026, 0, 1)), "2026-01-01"));
test("fees and missing price coverage follow the same filters and grouping", () => {
  const events = [
    { ...fixture[0], cost: 1.77, price_basis: "historical_estimate" },
    { ...fixture[1], cost: 0 },
    { ...fixture[0], model: "unpriced", cost: null },
  ];
  const total = summarize(events);
  assert.equal(total.cost, 1.77);
  assert.equal(total.priced, 2);
  assert.equal(total.unpriced, 1);
  assert.equal(total.historical, 1);
  const known = summarize(events.filter((e) => e.model === "a"));
  assert.equal(known.unpriced, 0);
  assert.equal(groups(events, "model").find((g) => g.name === "unpriced").priced, 0);
  assert.equal(trend(events, "day")[0].cost, total.cost);
  assert.equal(trend(events, "day")[0].unpriced, 1);
});
test("performance metrics exclude failed, output-less and invalid timing samples", () => {
  const events = [
    { ...fixture[0], output: 100, latency_ms: 2500, ttft_ms: 500 },
    { ...fixture[0], output: 100, latency_ms: 2500, ttft_ms: 0 },
    { ...fixture[0], output: 100, latency_ms: 2500, ttft_ms: 500, failed: true },
    { ...fixture[0], output: 0, latency_ms: 2500, ttft_ms: 500 },
    { ...fixture[0], output: 100, latency_ms: 2500, ttft_ms: 3000 },
    { ...fixture[0], output: 100, latency_ms: 0, ttft_ms: 0 },
  ];
  const s = summarize(events);
  assert.equal(s.latencySamples, 5);
  assert.equal(s.ttftSamples, 3);
  assert.equal(s.tpsSamples, 2);
  assert.ok(Math.abs(s.tps - 44.44444444444444) < 1e-10);
  assert.equal(s.avgLatencyMs, 2500);
  assert.equal(s.avgTTFTMs, 500);
  assert.equal(requestTPS(events[4]), null);
  assert.equal(formatTPS(s.tps), "44.44");
  assert.equal(formatDuration(s.avgLatencyMs), "2.50 s");
  assert.equal(formatDuration(null), "—");
});
test("unpriced trend buckets remain gaps and free buckets remain zero", () => {
  const buckets = trend([{ ...fixture[0], cost: null }, { ...fixture[1], cost: 0 }], "hour");
  assert.equal(buckets[0].cost, null);
  assert.equal(buckets[1].cost, 0);
  assert.equal(money(null), "未定价");
  assert.equal(money(0), "$0.00");
  assert.equal(money(0.0000001), "< $0.000001");
});
