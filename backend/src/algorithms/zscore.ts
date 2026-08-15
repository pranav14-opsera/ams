/**
 * Z-score anomaly detection — WO-061's own algorithm for token
 * consumption spikes/drops, computed against a baseline mean/stddev
 * (established during the 7-day calibration period, not recomputed
 * on-the-fly from raw history on every tick).
 */

export interface ZScoreResult {
  zScore: number;
  /** Absolute deviation magnitude in original units (|value - mean|) — the "statistical evidence" this WO's AC requires alongside the sigma count. */
  deviationMagnitude: number;
}

const MIN_VARIANCE_FLOOR = 0.001; // AC's own explicit floor — prevents a division-by-near-zero blowing up the z-score for a genuinely constant metric

export function computeZScore(value: number, baselineMean: number, baselineVariance: number): ZScoreResult {
  if (!Number.isFinite(value) || !Number.isFinite(baselineMean) || !Number.isFinite(baselineVariance)) {
    throw new RangeError("value, baselineMean, and baselineVariance must all be finite numbers");
  }
  if (baselineVariance < 0) throw new RangeError(`baselineVariance must be non-negative, got ${baselineVariance}`);

  const flooredVariance = Math.max(baselineVariance, MIN_VARIANCE_FLOOR);
  const stddev = Math.sqrt(flooredVariance);
  const zScore = (value - baselineMean) / stddev;

  return { zScore, deviationMagnitude: Math.abs(value - baselineMean) };
}

export function isAnomalous(zScoreResult: ZScoreResult, sigmaThreshold: number): boolean {
  return Math.abs(zScoreResult.zScore) >= sigmaThreshold;
}
