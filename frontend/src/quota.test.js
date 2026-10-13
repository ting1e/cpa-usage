import test from "node:test";
import assert from "node:assert/strict";
import { eventCost, costs, estimateQuotas, validatePrices, formatUSD } from "./quota.js";

const prices = { test: { input: 2, cache: 0.2, output: 10 } };
const now = 1000000;
const event = (ts, used, overrides = {}) => ({
  ts, observed_ts: ts + 1, latency_ms: 1000,
  provider: "codex", account: "account-a", model: "test", failed: false,
  input: 1000000, cache: 500000, output: 100000, reasoning: 50000,
  quota: { plan: "plus", five_hour: { used_percent: used, reset_at: now + 1000 },
    week: { used_percent: used / 2, reset_at: now + 10000 } }, ...overrides,
});
const fixture = () => [event(now - 30, 10), event(now - 28, 12), event(now - 26, 14)];
const window = (records, key = "five_hour") => estimateQuotas(records, prices, now).accounts[0].windows[key];

test("API-equivalent cost counts cache as input subset and reasoning as output subset", () => {
  assert.equal(eventCost(event(now, 10), prices), 2.1);
  assert.equal(eventCost(event(now, 10, { failed: true }), prices), 2.1);
  assert.equal(eventCost(event(now, 10, { response_model: "test", model: "alias" }), prices), 2.1);
  for (const overrides of [{ model: "unknown" }, { cache: 2000000 }, { input: -1 }, { output: NaN }]) {
    assert.equal(eventCost(event(now, 10, overrides), prices), null);
  }
  assert.deepEqual(costs([event(now, 1), event(now, 2, { model: "unknown" })], prices), { usd: 2.1, priced: 1, unpriced: 1 });
  assert.equal(costs([], prices).usd, null);
});
test("price validation rejects malformed and missing rates instead of inventing zero costs", () => {
  assert.equal(validatePrices(prices), prices);
  for (const p of [null, [], { test: { input: 1, output: 1 } }, { test: { input: -1, cache: 0, output: 1 } }]) {
    assert.throws(() => validatePrices(p));
  }
  assert.equal(formatUSD(null), "—");
  assert.equal(formatUSD(0), "$0.00");
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
test("idle external consumption establishes a new baseline and is never accumulated", () => {
  const records = [...fixture(), event(now - 10, 80), event(now - 8, 82), event(now - 6, 84)];
  const w = window(records);
  assert.equal(w.observedPercent, 8); // not the account-wide 74 percentage-point delta
  assert.equal(w.samples, 4);
  assert.equal(w.remainingPercent, 16); // account-wide remaining, NOT CPA consumption
});
test("missing quota, failures and concurrency break the sample chain", () => {
  for (const overrides of [{ quota: null }, { failed: true }, { model: "other" }, { service_tier: "priority" }, { latency_ms: 0 }]) {
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
  const data = estimateQuotas([...fixture(), event(now - 25, 90, { account: "account-b" }), event(now - 22, 95, { account: "", key: "same-client" })], prices, now);
  assert.equal(data.accounts.length, 2);
  assert.equal(data.accounts[0].windows.five_hour.observedPercent, 4);
  assert.equal(data.accounts[1].windows.five_hour.fullUSD, null);
  assert.equal(data.missingAccount, 1);
  assert.equal(estimateQuotas([event(now, 20, { provider: "openai" })], prices, now).accounts.length, 0);
});
test("empty, expired, zero-delta and insufficient observations remain unknown", () => {
  assert.deepEqual(estimateQuotas([], prices, now), { missingAccount: 0, accounts: [] });
  assert.equal(window([event(now - 10, 10)]).fullUSD, null);
  assert.equal(window([event(now - 10, 10), event(now - 8, 10), event(now - 6, 10)]).fullUSD, null);
  const expired = estimateQuotas(fixture(), prices, now + 2000).accounts[0].windows.five_hour;
  assert.equal(expired.active, false);
  assert.equal(expired.remainingPercent, null);
  assert.equal(expired.fullUSD, null);
  assert.equal(window([event(now - 10, 10, { quota: null })]), null);
});
test("USD and quota estimates respond to user prices without leaking model filters into account sampling", () => {
  const records = fixture();
  const base = estimateQuotas(records, prices, now).accounts[0].windows.five_hour;
  const doubled = estimateQuotas(records, { test: { input: 4, cache: 0.4, output: 20 } }, now).accounts[0].windows.five_hour;
  assert.equal(doubled.fullUSD, base.fullUSD * 2);
  assert.equal(doubled.estimatedCPAPercent, base.estimatedCPAPercent);
  assert.equal(window(records.map((e) => ({ ...e, model: "unknown" }))).fullUSD, null);
});
