import { test } from "node:test";
import assert from "node:assert/strict";
import { computeZScore, isAnomalous } from "../../src/algorithms/zscore";

test("a value exactly at the baseline mean has a z-score of 0", () => {
  const result = computeZScore(500, 500, 2500); // stddev 50
  assert.equal(result.zScore, 0);
  assert.equal(result.deviationMagnitude, 0);
});

test("a value one standard deviation above the mean has a z-score of 1", () => {
  const result = computeZScore(550, 500, 2500); // stddev 50
  assert.ok(Math.abs(result.zScore - 1) < 1e-9);
  assert.equal(result.deviationMagnitude, 50);
});

test("a value below the mean produces a negative z-score, with a positive deviationMagnitude", () => {
  const result = computeZScore(400, 500, 2500);
  assert.ok(result.zScore < 0);
  assert.equal(result.deviationMagnitude, 100);
});

test("zero baseline variance is floored (AC's own MIN_VARIANCE_FLOOR) rather than producing Infinity/NaN from a division by zero", () => {
  const result = computeZScore(505, 500, 0);
  assert.ok(Number.isFinite(result.zScore));
  assert.ok(result.zScore > 0);
});

test("a genuinely extreme spike produces a large z-score", () => {
  const result = computeZScore(5000, 500, 2500);
  assert.ok(result.zScore > 50);
});

test("negative baselineVariance throws rather than silently producing a nonsensical result", () => {
  assert.throws(() => computeZScore(500, 500, -10), RangeError);
});

test("non-finite inputs throw", () => {
  assert.throws(() => computeZScore(NaN, 500, 2500), RangeError);
  assert.throws(() => computeZScore(500, NaN, 2500), RangeError);
  assert.throws(() => computeZScore(500, 500, NaN), RangeError);
});

test("isAnomalous: a z-score under the sigma threshold is not anomalous", () => {
  const result = computeZScore(520, 500, 2500); // z = 0.4
  assert.equal(isAnomalous(result, 3), false);
});

test("isAnomalous: a z-score at or above the sigma threshold IS anomalous, checked on the absolute value (works for drops too)", () => {
  const highResult = computeZScore(650, 500, 2500); // z = 3
  assert.equal(isAnomalous(highResult, 3), true);
  const lowResult = computeZScore(350, 500, 2500); // z = -3
  assert.equal(isAnomalous(lowResult, 3), true);
});

test("sensitivity levels: the same deviation is anomalous at 'high' (2 sigma) but not at 'low' (4 sigma)", () => {
  const result = computeZScore(650, 500, 2500); // z = 3
  assert.equal(isAnomalous(result, 2), true); // high sensitivity
  assert.equal(isAnomalous(result, 4), false); // low sensitivity
});
