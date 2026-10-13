import test from "node:test";
import assert from "node:assert/strict";
import { summarize, groups, trend, dateKey, requestTPS, formatTPS, formatDuration } from "./analytics.js";
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
test("local date does not use UTC slicing", () =>
  assert.equal(dateKey(new Date(2026, 0, 1)), "2026-01-01"));

const timedEvent = (overrides = {}) => ({
  ...fixture[0], output: 100, latency_ms: 2500, ttft_ms: 500, ...overrides,
});
test("TPS excludes TTFT and does not add reasoning tokens", () => {
  assert.equal(requestTPS(timedEvent({ reasoning: 80 })), 50);
  assert.equal(requestTPS(timedEvent({ ttft_ms: 0 })), 40);
  assert.equal(requestTPS(timedEvent({ ttft_ms: undefined })), 40);
  assert.equal(requestTPS(timedEvent({ latency_ms: 0.5, ttft_ms: 0.25 })), 400000);
});
test("invalid or unsuccessful requests have no TPS", () => {
  for (const overrides of [
    { failed: true }, { output: 0 }, { output: -1 }, { output: NaN },
    { latency_ms: 0 }, { latency_ms: -1 }, { latency_ms: undefined },
    { latency_ms: Infinity }, { latency_ms: NaN },
    { ttft_ms: -1 }, { ttft_ms: 2500 }, { ttft_ms: 3000 },
    { ttft_ms: NaN }, { ttft_ms: Infinity },
  ]) assert.equal(requestTPS(timedEvent(overrides)), null);
});
test("aggregate TPS weights generation duration instead of averaging rates", () => {
  const events = [
    timedEvent(),
    timedEvent({ output: 300, latency_ms: 1500, ttft_ms: 500 }),
    timedEvent({ failed: true, latency_ms: 1000, ttft_ms: 200 }),
    timedEvent({ latency_ms: 0, ttft_ms: 0 }),
  ];
  const s = summarize(events);
  assert.equal(s.tps, 400 * 1000 / 3000);
  assert.equal(s.tpsSamples, 2);
  assert.equal(s.avgLatencyMs, 5000 / 3);
  assert.equal(s.latencySamples, 3);
  assert.equal(s.avgTTFTMs, 400);
  assert.equal(s.ttftSamples, 3);
  assert.equal(s.n, 4);
  assert.equal(s.fail, 1);
});
test("model and key performance aggregates only include their own requests", () => {
  const events = [timedEvent(), timedEvent({ model: "b", key: "k2", output: 300 })];
  assert.equal(groups(events, "model").find((g) => g.name === "a").tps, 50);
  assert.equal(groups(events, "key").find((g) => g.name === "k2").tps, 150);
  assert.equal(summarize(events.filter((e) => e.model === "b")).avgLatencyMs, 2500);
});
test("empty and historical events do not report invented performance metrics", () => {
  for (const events of [[], fixture]) {
    const s = summarize(events);
    assert.equal(s.tps, null);
    assert.equal(s.avgLatencyMs, null);
    assert.equal(s.avgTTFTMs, null);
    assert.equal(s.tpsSamples, 0);
  }
  const s = summarize([
    timedEvent({ ttft_ms: 0 }), timedEvent({ ttft_ms: 3000 }),
    timedEvent({ latency_ms: -1 }),
  ]);
  assert.equal(s.avgLatencyMs, 2500);
  assert.equal(s.avgTTFTMs, null);
  assert.equal(s.tpsSamples, 1);
});
test("performance formatting distinguishes missing values from measured values", () => {
  assert.equal(formatTPS(12.345), "12.35");
  assert.equal(formatDuration(1250), "1.25 s");
  for (const value of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.equal(formatTPS(value), "—");
    assert.equal(formatDuration(value), "—");
  }
});
