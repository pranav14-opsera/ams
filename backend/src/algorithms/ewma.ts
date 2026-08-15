/**
 * Exponentially Weighted Moving Average — WO-061's own primary algorithm
 * for detecting gradual latency/error-rate drift that a static threshold
 * (WO-059) never crosses. Each update folds one new observation into a
 * running mean AND variance estimate without needing to retain the full
 * observation history (the entire point of EWMA over a plain rolling
 * window: O(1) state per agent+metric, not O(n) history).
 */

export interface EwmaState {
  mean: number;
  /** Exponentially weighted variance — Welford-style incremental update, NOT the naive (value-mean)^2 running average, which biases high under a shifting mean. */
  variance: number;
  /** Observation count — informational only (calibration-period enforcement uses wall-clock days elapsed, not this count), but useful for callers to distinguish "freshly initialized" from "long-running". */
  observationCount: number;
}

export function initialEwmaState(firstValue: number): EwmaState {
  return { mean: firstValue, variance: 0, observationCount: 1 };
}

/**
 * @param lambda The smoothing factor in (0, 1]. Higher = more weight on
 * the newest observation (faster to react, noisier); lower = smoother,
 * slower to react. 0.1–0.3 is a typical choice for per-tick metric
 * smoothing; this module doesn't hardcode a default — the caller (
 * AnomalyDetectorService) owns that policy decision.
 */
export function updateEwma(state: EwmaState, value: number, lambda: number): EwmaState {
  if (lambda <= 0 || lambda > 1) throw new RangeError(`lambda must be in (0, 1], got ${lambda}`);
  if (!Number.isFinite(value)) throw new RangeError(`value must be a finite number, got ${value}`);

  const delta = value - state.mean;
  const newMean = state.mean + lambda * delta;
  // Incremental EWMA variance: weights the squared deviation from the
  // OLD mean the same way the mean update itself is weighted, then
  // exponentially decays the previous variance estimate — the standard
  // "EWMA of squared deviations" formulation (avoids the more expensive
  // two-pass "correct" weighted variance, which the calibration window
  // covers by initializing this from real historical data instead).
  const newVariance = (1 - lambda) * (state.variance + lambda * delta * delta);

  return { mean: newMean, variance: newVariance, observationCount: state.observationCount + 1 };
}

/** How many standard deviations `value` sits from the current EWMA mean — the "statistical evidence" (deviation magnitude) this WO's AC requires on every anomaly alert event. */
export function ewmaDeviationSigma(state: EwmaState, value: number): number {
  const stddev = Math.sqrt(state.variance);
  if (stddev === 0) return value === state.mean ? 0 : Number.POSITIVE_INFINITY;
  return (value - state.mean) / stddev;
}
