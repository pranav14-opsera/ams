import { test } from "node:test";
import assert from "node:assert/strict";
import { granularityForRange, sinceIsoForRange } from "../../src/dashboard/health-history.util";

test("1h and 6h ranges use 5min granularity (the AC's 'short ranges' tier)", () => {
  assert.equal(granularityForRange("1h"), "5min");
  assert.equal(granularityForRange("6h"), "5min");
});

test("24h and 7d ranges use 1hr granularity (the AC's 'medium ranges' tier)", () => {
  assert.equal(granularityForRange("24h"), "1hr");
  assert.equal(granularityForRange("7d"), "1hr");
});

test("30d range uses 1day granularity (the AC's 'long ranges' tier)", () => {
  assert.equal(granularityForRange("30d"), "1day");
});

test("sinceIsoForRange computes the correct lookback window from a fixed 'now'", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  assert.equal(sinceIsoForRange("1h", now), "2026-08-16T11:00:00.000Z");
  assert.equal(sinceIsoForRange("24h", now), "2026-08-15T12:00:00.000Z");
  assert.equal(sinceIsoForRange("30d", now), "2026-07-17T12:00:00.000Z");
});
