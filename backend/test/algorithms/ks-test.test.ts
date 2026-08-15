import { test } from "node:test";
import assert from "node:assert/strict";
import { twoSampleKsTest } from "../../src/algorithms/ks-test";

test("identical samples yield D=0 and p=1 (no evidence of any difference)", () => {
  const sample = [85, 86, 84, 85, 87, 83, 85, 86];
  const result = twoSampleKsTest(sample, [...sample]);
  assert.equal(result.statistic, 0);
  assert.equal(result.pValue, 1);
});

test("clearly different distributions (baseline ~85 vs degraded ~70) yield a small p-value", () => {
  // Deterministic, evenly-spaced "distributions" rather than Math.random() — reproducible test data.
  const baseline = Array.from({ length: 30 }, (_, i) => 80 + (i % 11)); // 80-90 range, centered ~85
  const degraded = Array.from({ length: 30 }, (_, i) => 65 + (i % 11)); // 65-75 range, centered ~70
  const result = twoSampleKsTest(baseline, degraded);
  assert.ok(result.statistic > 0.5, `expected a large KS statistic for clearly separated distributions, got ${result.statistic}`);
  assert.ok(result.pValue < 0.01, `expected p < 0.01 for clearly different distributions, got ${result.pValue}`);
});

test("samples drawn from overlapping but shifted ranges show a borderline statistic and p-value between the extremes", () => {
  const baseline = Array.from({ length: 40 }, (_, i) => 80 + (i % 15)); // 80-94
  const slightlyLower = Array.from({ length: 40 }, (_, i) => 76 + (i % 15)); // 76-90 (mostly overlapping)
  const result = twoSampleKsTest(baseline, slightlyLower);
  assert.ok(result.statistic > 0 && result.statistic < 0.6, `expected a moderate statistic, got ${result.statistic}`);
});

test("the KS statistic is symmetric — swapping sample order doesn't change D or the p-value", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8];
  const b = [10, 11, 12, 13, 14, 15];
  const forward = twoSampleKsTest(a, b);
  const backward = twoSampleKsTest(b, a);
  assert.equal(forward.statistic, backward.statistic);
  assert.equal(forward.pValue, backward.pValue);
});

test("minimum viable sample sizes (a single point each) don't throw and produce a valid result", () => {
  const result = twoSampleKsTest([85], [70]);
  assert.equal(result.statistic, 1); // completely disjoint single-point samples -> maximal separation
  assert.equal(result.sampleSizeA, 1);
  assert.equal(result.sampleSizeB, 1);
});

test("an empty sample throws rather than silently returning a meaningless result", () => {
  assert.throws(() => twoSampleKsTest([], [1, 2, 3]), RangeError);
  assert.throws(() => twoSampleKsTest([1, 2, 3], []), RangeError);
});

test("a non-finite value in either sample throws", () => {
  assert.throws(() => twoSampleKsTest([1, 2, NaN], [1, 2, 3]), RangeError);
  assert.throws(() => twoSampleKsTest([1, 2, 3], [1, Infinity]), RangeError);
});

test("differently-sized samples are handled correctly (KS test doesn't require equal n)", () => {
  const small = [85, 86, 87];
  const large = Array.from({ length: 50 }, (_, i) => 84 + (i % 5));
  const result = twoSampleKsTest(small, large);
  assert.ok(Number.isFinite(result.statistic));
  assert.ok(result.pValue >= 0 && result.pValue <= 1);
});

test("the p-value is always within [0, 1]", () => {
  const cases: Array<[number[], number[]]> = [
    [[1, 2, 3], [1, 2, 3]],
    [[1, 2, 3], [100, 200, 300]],
    [Array.from({ length: 100 }, (_, i) => i), Array.from({ length: 100 }, (_, i) => i + 1)],
  ];
  for (const [a, b] of cases) {
    const result = twoSampleKsTest(a, b);
    assert.ok(result.pValue >= 0 && result.pValue <= 1, `p-value ${result.pValue} out of [0,1] range`);
  }
});
