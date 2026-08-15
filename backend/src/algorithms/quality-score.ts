export interface QualityScoreComponents {
  /** 0-1 fraction, or null if there's no data for this window. */
  toolCallSuccessRate: number | null;
  /** 0-1 fraction, or null if there's no data for this window. */
  reasoningAccuracy: number | null;
  /** 0-1 fraction (1 = perfectly consistent), or null if there isn't enough data to compute a variance. */
  outputConsistency: number | null;
}

export interface QualityScoreWeights {
  toolCall: number;
  reasoning: number;
  consistency: number;
}

export interface QualityScoreResult {
  /** 0-100, or null if every component was null (no data at all this window). */
  compositeScore: number | null;
  /** Each component's own 0-100 score, or null if that component had no data. */
  componentScores: {
    toolCall: number | null;
    reasoning: number | null;
    consistency: number | null;
  };
  /** How many of the 3 components actually contributed (0-3) — the caller's own signal for "computed from a partial, reweighted subset". */
  sampleCount: number;
}

export const DEFAULT_QUALITY_SCORE_WEIGHTS: QualityScoreWeights = { toolCall: 40, reasoning: 35, consistency: 25 };

/**
 * Weighted composite of 3 components, each expected as a 0-1 fraction (or
 * null when there's no data). AC: 40/35/25 default weights, normalized to
 * 0-100.
 *
 * Missing-component handling: a null component is EXCLUDED, and its
 * weight is redistributed proportionally across the remaining non-null
 * components, rather than either (a) treating missing as 0 — which would
 * punish an agent for a component this window simply has no data for, or
 * (b) nulling the whole composite — which would make a score unavailable
 * for the common case of a quiet agent with no execution traces this
 * tick but perfectly good telemetry. If every component is null, the
 * composite itself is null (no data at all to compute anything from).
 */
export function computeQualityScore(components: QualityScoreComponents, weights: QualityScoreWeights = DEFAULT_QUALITY_SCORE_WEIGHTS): QualityScoreResult {
  if (weights.toolCall < 0 || weights.reasoning < 0 || weights.consistency < 0) {
    throw new RangeError("quality score weights must be non-negative");
  }
  const totalWeight = weights.toolCall + weights.reasoning + weights.consistency;
  if (totalWeight <= 0) throw new RangeError("quality score weights must sum to a positive number");

  const entries: Array<{ key: "toolCall" | "reasoning" | "consistency"; value: number | null; weight: number }> = [
    { key: "toolCall", value: components.toolCallSuccessRate, weight: weights.toolCall },
    { key: "reasoning", value: components.reasoningAccuracy, weight: weights.reasoning },
    { key: "consistency", value: components.outputConsistency, weight: weights.consistency },
  ];

  const componentScores: QualityScoreResult["componentScores"] = { toolCall: null, reasoning: null, consistency: null };
  let sampleCount = 0;
  let availableWeight = 0;
  let weightedSum = 0;

  for (const entry of entries) {
    if (entry.value === null) continue;
    if (!Number.isFinite(entry.value)) throw new RangeError(`component "${entry.key}" must be a finite number or null, got ${entry.value}`);
    const clamped = Math.max(0, Math.min(1, entry.value));
    const score0to100 = clamped * 100;
    componentScores[entry.key] = Math.round(score0to100);
    sampleCount++;
    availableWeight += entry.weight;
    weightedSum += score0to100 * entry.weight;
  }

  if (availableWeight === 0) return { compositeScore: null, componentScores, sampleCount: 0 };

  const compositeScore = Math.max(0, Math.min(100, Math.round(weightedSum / availableWeight)));
  return { compositeScore, componentScores, sampleCount };
}
