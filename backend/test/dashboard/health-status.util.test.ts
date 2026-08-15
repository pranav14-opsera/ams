import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHealthStatus } from "../../src/dashboard/health-status.util";

test("paused lifecycle always wins, regardless of metrics", () => {
  assert.equal(computeHealthStatus("paused", { errorRateAvg: 0.9, latencyP99Ms: 99_999 }), "paused");
});

test("retired and decommissioned lifecycle both map to 'retired'", () => {
  assert.equal(computeHealthStatus("retired", null), "retired");
  assert.equal(computeHealthStatus("decommissioned", { errorRateAvg: 0, latencyP99Ms: 0 }), "retired");
});

test("no metrics yet defaults to active for a non-paused/retired lifecycle", () => {
  assert.equal(computeHealthStatus("connecting", null), "active");
  assert.equal(computeHealthStatus("active", null), "active");
});

test("error rate above the error threshold is 'error', regardless of latency", () => {
  assert.equal(computeHealthStatus("active", { errorRateAvg: 0.06, latencyP99Ms: 10 }), "error");
});

test("error rate between the degraded and error thresholds is 'degraded'", () => {
  assert.equal(computeHealthStatus("active", { errorRateAvg: 0.02, latencyP99Ms: 10 }), "degraded");
});

test("latency above the degraded threshold is 'degraded' even with a healthy error rate", () => {
  assert.equal(computeHealthStatus("active", { errorRateAvg: 0, latencyP99Ms: 6_000 }), "degraded");
});

test("healthy error rate and latency is 'active'", () => {
  assert.equal(computeHealthStatus("active", { errorRateAvg: 0, latencyP99Ms: 100 }), "active");
});

test("null metric fields within a present metrics object are treated as 0 (healthy)", () => {
  assert.equal(computeHealthStatus("active", { errorRateAvg: null, latencyP99Ms: null }), "active");
});

test("custom thresholds are honored", () => {
  assert.equal(
    computeHealthStatus("active", { errorRateAvg: 0.2, latencyP99Ms: 0 }, { errorRateErrorThreshold: 0.5, errorRateDegradedThreshold: 0.1, latencyP99DegradedMs: 1000 }),
    "degraded",
  );
});
