import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDriftStatus, computeQualityScore } from "../../src/dashboard/quality-score.util";

test("computeQualityScore: perfect tool-call success and zero error rate scores 100", () => {
  assert.equal(computeQualityScore(1, 0), 100);
});

test("computeQualityScore: a high error rate pulls the score down", () => {
  const withoutErrors = computeQualityScore(1, 0)!;
  const withErrors = computeQualityScore(1, 0.5)!;
  assert.ok(withErrors < withoutErrors);
});

test("computeQualityScore: a low tool-call success rate pulls the score down", () => {
  const highSuccess = computeQualityScore(0.99, 0)!;
  const lowSuccess = computeQualityScore(0.2, 0)!;
  assert.ok(lowSuccess < highSuccess);
});

test("computeQualityScore: no metrics at all (both null) returns null, not a fabricated number", () => {
  assert.equal(computeQualityScore(null, null), null);
});

test("computeQualityScore: is always clamped within [0, 100]", () => {
  const score = computeQualityScore(0, 5)!; // error_rate way above 1.0
  assert.ok(score >= 0 && score <= 100);
});

test("computeDriftStatus: insufficient_data when there's no baseline at all", () => {
  assert.equal(computeDriftStatus({ recentErrorRateAvg: 0.5, recentLatencyP99Ms: 500, baselineErrorRateAvg: null, baselineLatencyP99Ms: null }), "insufficient_data");
});

test("computeDriftStatus: stable when recent metrics are close to baseline", () => {
  assert.equal(computeDriftStatus({ recentErrorRateAvg: 0.01, recentLatencyP99Ms: 200, baselineErrorRateAvg: 0.01, baselineLatencyP99Ms: 200 }), "stable");
});

test("computeDriftStatus: drifting_up when the recent error rate is far worse than baseline", () => {
  assert.equal(computeDriftStatus({ recentErrorRateAvg: 0.3, recentLatencyP99Ms: 200, baselineErrorRateAvg: 0.05, baselineLatencyP99Ms: 200 }), "drifting_up");
});

test("computeDriftStatus: drifting_up when recent P99 latency is far worse than baseline, even with a healthy error rate", () => {
  assert.equal(computeDriftStatus({ recentErrorRateAvg: 0, recentLatencyP99Ms: 5000, baselineErrorRateAvg: 0, baselineLatencyP99Ms: 500 }), "drifting_up");
});

test("computeDriftStatus: drifting_down when the recent window is meaningfully BETTER than baseline", () => {
  assert.equal(computeDriftStatus({ recentErrorRateAvg: 0.01, recentLatencyP99Ms: 100, baselineErrorRateAvg: 0.3, baselineLatencyP99Ms: 100 }), "drifting_down");
});
