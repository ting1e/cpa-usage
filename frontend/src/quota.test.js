import test from "node:test";
import assert from "node:assert/strict";
import { eventCost, costs, estimateQuotas } from "./quota.js";

const now = 1000000;
const event = (ts, used, overrides = {}) => ({
  ts, observed_ts: ts + 1, latency_ms: 1000,
  provider: "codex", account: "account-a", model: "test", failed: false,
  input: 1000000, cache: 500000, output: 100000, reasoning: 50000, cost: 2.1,
  quota: { plan: "plus", five_hour: { used_percent: used, reset_at: now + 1000 },
    week: { used_percent: used / 2, reset_at: now + 10000 } }, ...overrides,
});
const fixture = () => [event(now - 30, 10), event(now - 28, 12), event(now - 26, 14)];
const window = (records, key = "five_hour") => estimateQuotas(records, now).accounts[0].windows[key];

test("cost always comes from the backend canonical quote", () => {
  assert.equal(eventCost(event(now, 10)), 2.1);
  assert.equal(eventCost(event(now, 10, { cost: 0 })), 0);
  assert.equal(eventCost(event(now, 10, { cost: null })), null);
  assert.deepEqual(costs([event(now, 1), event(now, 2, { cost: null })]), { usd: 2.1, priced: 1, unpriced: 1 });
  assert.equal(costs([]).usd, null);
});
test("consecutive same-account samples estimate both windows and USD capacity", () => {
  const w = window(fixture());
  assert.equal(w.samples, 2);
  assert.equal(w.observedPercent, 4);
  assert.ok(Math.abs(w.estimatedCPAPercent - 6) < 1e-10);
  assert.ok(Math.abs(w.fullUSD - 105) < 1e-10);
  assert.ok(Math.abs(w.remainingUSD - 90.3) < 1e-10);
  assert.equal(w.remainingPercent, 86);
  assert.equal(w.fullTokens, 55000000);
  assert.equal(w.remainingTokens, 47300000);
  const week = window(fixture(), "week");
  assert.equal(week.observedPercent, 2);
  assert.ok(Math.abs(week.fullUSD - 210) < 1e-10);
});
test("models sharing one account are aggregated once, with per-model details", () => {
  const records = [
    event(now - 30, 10, { model: "gpt-6.1-sol", response_model: "gpt-6.1-sol" }),
    event(now - 28, 12, { model: "gpt-6.1-sol", response_model: "gpt-6.1-sol" }),
    event(now - 26, 14, { model: "gpt-6-terra", response_model: "gpt-6-terra", cost: 4.2 }),
    event(now - 24, 18, { model: "gpt-6-terra", response_model: "gpt-6-terra", cost: 4.2 }),
  ];
  const data = estimateQuotas(records, now);
  assert.equal(data.accounts.length, 1);
  const w = data.accounts[0].windows.five_hour;
  assert.equal(w.samples, 3);
  assert.equal(w.observedPercent, 8);
  assert.equal(w.models.length, 2);
  assert.deepEqual(w.models.map((m) => m.model).sort(), ["gpt-6-terra", "gpt-6.1-sol"]);
  assert.equal(w.models.reduce((n, m) => n + m.requests, 0), w.coveredRequests);
  assert.equal(w.estimatedCPAPercent !== null, true);
});
test("idle external consumption establishes a new baseline and is never accumulated", () => {
  const records = [...fixture(), event(now - 10, 80), event(now - 8, 82), event(now - 6, 84)];
  const w = window(records);
  assert.equal(w.observedPercent, 8); // not the account-wide 74 percentage-point delta
  assert.equal(w.samples, 4);
  assert.equal(w.remainingPercent, 16); // account-wide remaining, NOT CPA consumption
});
test("missing quota, failures, missing cost and concurrency break the sample chain", () => {
  for (const overrides of [{ quota: null }, { failed: true }, { cost: null }, { latency_ms: 0 }]) {
    const records = [event(now - 10, 10), event(now - 8, 30, overrides), event(now - 6, 40)];
    assert.equal(window(records).samples, 0);
    assert.equal(window(records).fullUSD, null);
  }
  const concurrent = [event(now - 10, 10, { latency_ms: 5000 }), event(now - 9, 20), event(now - 6, 30), event(now - 4, 40)];
  assert.equal(window(concurrent).samples, 0);
  const laterOverlap = [event(now - 10, 10), event(now - 8, 20, { latency_ms: 5000 }), event(now - 7, 30)];
  assert.equal(window(laterOverlap).samples, 0);
});
test("resets and out-of-order snapshots cannot create positive debit samples", () => {
  const reset = { plan: "plus", five_hour: { used_percent: 2, reset_at: now + 5000 } };
  assert.equal(window([...fixture(), event(now - 24, 2, { quota: reset })]).samples, 0);
  assert.equal(window([event(now - 10, 20), event(now - 8, 10), event(now - 6, 12)]).samples, 1);
  assert.equal(window([event(now - 10, 20), event(now - 8, 30, { observed_ts: now - 20 }), event(now - 6, 40)]).samples, 1);
});
test("accounts stay separate and never fall back to client Key as account identity", () => {
  const data = estimateQuotas([...fixture(), event(now - 25, 90, { account: "account-b" }), event(now - 22, 95, { account: "", key: "same-client" })], now);
  assert.equal(data.accounts.length, 2);
  assert.equal(data.accounts[0].windows.five_hour.observedPercent, 4);
  assert.equal(data.accounts[1].windows.five_hour.fullUSD, null);
  assert.equal(data.missingAccount, 1);
  assert.equal(estimateQuotas([event(now, 20, { provider: "openai" })], now).accounts.length, 0);
});
test("empty, expired, zero-delta and insufficient observations remain unknown", () => {
  assert.deepEqual(estimateQuotas([], now), { missingAccount: 0, accounts: [] });
  assert.equal(window([event(now - 10, 10)]).fullUSD, null);
  assert.equal(window([event(now - 10, 10), event(now - 8, 10), event(now - 6, 10)]).fullUSD, null);
  const expired = estimateQuotas(fixture(), now + 2000).accounts[0].windows.five_hour;
  assert.equal(expired.active, false);
  assert.equal(expired.remainingPercent, null);
  assert.equal(expired.fullUSD, null);
  assert.equal(window([event(now - 10, 10, { quota: null })]), null);
});
test("quota history keeps the recent 30-day observations for both windows", () => {
  const w = window(fixture());
  assert.equal(w.history.length, 3);
  assert.deepEqual(w.history.map((h) => h.usedPercent), [10, 12, 14]);
  assert.ok(w.history[0].observedAt < w.history[2].observedAt);
  assert.equal(window(fixture(), "week").history.length, 3);
});
