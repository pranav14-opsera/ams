import { test } from "node:test";
import assert from "node:assert/strict";
import { computeQualityScore, DEFAULT_QUALITY_SCORE_WEIGHTS } from "../../src/algorithms/quality-score";

test("perfect scores across all 3 components yields a composite of 100", () => {
  const result = computeQualityScore({ toolCallSuccessRate: 1, reasoningAccuracy: 1, outputConsistency: 1 });
  assert.equal(result.compositeScore, 100);
  assert.deepEqual(result.componentScores, { toolCall: 100, reasoning: 100, consistency: 100 });
  assert.equal(result.sampleCount, 3);
});

test("zero scores across all 3 components yields a composite of 0", () => {
  const result = computeQualityScore({ toolCallSuccessRate: 0, reasoningAccuracy: 0, outputConsistency: 0 });
  assert.equal(result.compositeScore, 0);
});

test("default weights (40/35/25) are applied correctly for a mixed set of scores", () => {
  const result = computeQualityScore({ toolCallSuccessRate: 0.9, reasoningAccuracy: 0.8, outputConsistency: 0.7 });
  // 90*0.40 + 80*0.35 + 70*0.25 = 36 + 28 + 17.5 = 81.5 -> rounds to 82 (or 81, depending on rounding of intermediate component scores — component scores round first: 90, 80, 70, so weighted sum is exact)
  assert.equal(result.compositeScore, 82);
});

test("a missing (null) component is excluded and its weight redistributed across the remaining components", () => {
  // toolCall=1.0 (weight 40), reasoning=null (excluded), consistency=0.5 (weight 25) -> renormalized: 100*40/65 + 50*25/65 = 61.5 + 19.2 = 80.8 -> 81
  const result = computeQualityScore({ toolCallSuccessRate: 1, reasoningAccuracy: null, outputConsistency: 0.5 });
  assert.equal(result.componentScores.reasoning, null);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.compositeScore, 81);
});

test("all 3 components null yields a null composite score, not a fabricated number", () => {
  const result = computeQualityScore({ toolCallSuccessRate: null, reasoningAccuracy: null, outputConsistency: null });
  assert.equal(result.compositeScore, null);
  assert.equal(result.sampleCount, 0);
});

test("custom weights are honored over the defaults", () => {
  const result = computeQualityScore({ toolCallSuccessRate: 1, reasoningAccuracy: 0, outputConsistency: 0 }, { toolCall: 100, reasoning: 0, consistency: 0 });
  assert.equal(result.compositeScore, 100);
});

test("a value outside [0,1] is clamped, not allowed to blow the score past 100 or below 0", () => {
  const result = computeQualityScore({ toolCallSuccessRate: 1.5, reasoningAccuracy: -0.5, outputConsistency: 1 });
  assert.equal(result.componentScores.toolCall, 100);
  assert.equal(result.componentScores.reasoning, 0);
});

test("a non-finite component value throws rather than silently propagating NaN", () => {
  assert.throws(() => computeQualityScore({ toolCallSuccessRate: NaN, reasoningAccuracy: 0.5, outputConsistency: 0.5 }), RangeError);
});

test("negative weights throw", () => {
  assert.throws(() => computeQualityScore({ toolCallSuccessRate: 1, reasoningAccuracy: 1, outputConsistency: 1 }, { toolCall: -10, reasoning: 60, consistency: 50 }), RangeError);
});

test("all-zero weights throw (nothing to normalize against)", () => {
  assert.throws(() => computeQualityScore({ toolCallSuccessRate: 1, reasoningAccuracy: 1, outputConsistency: 1 }, { toolCall: 0, reasoning: 0, consistency: 0 }), RangeError);
});

test("DEFAULT_QUALITY_SCORE_WEIGHTS sums to 100, matching the AC's own default split", () => {
  assert.equal(DEFAULT_QUALITY_SCORE_WEIGHTS.toolCall + DEFAULT_QUALITY_SCORE_WEIGHTS.reasoning + DEFAULT_QUALITY_SCORE_WEIGHTS.consistency, 100);
});

test("only one component present (the other two null) scores purely off that one component", () => {
  const result = computeQualityScore({ toolCallSuccessRate: 0.42, reasoningAccuracy: null, outputConsistency: null });
  assert.equal(result.compositeScore, 42);
  assert.equal(result.sampleCount, 1);
});
