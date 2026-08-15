export type DriftStatus = "stable" | "drifting_up" | "drifting_down" | "insufficient_data";

export interface RecentVsBaselineMetrics {
  recentErrorRateAvg: number | null;
  recentLatencyP99Ms: number | null;
  baselineErrorRateAvg: number | null;
  baselineLatencyP99Ms: number | null;
}

/**
 * A lightweight, cheaply-computed proxy — NOT a real anomaly-detection
 * system. WO-061 ("Anomaly Detection") is this platform's own actual
 * scope for that; this WO's AC only asks the detail view to display
 * SOME quality score and drift status, and building a genuine
 * statistical/ML detector here would both preempt WO-061's explicit
 * scope and be far outside WO-057's own listed implementation steps.
 * Documented here rather than silently inventing a heavier system.
 *
 * Quality score (0-100): a weighted blend of tool-call success rate
 * (most of the score) and inverse error rate (a penalty) — both already
 * computed by the existing metrics aggregate views, so this needs no new
 * data collection.
 */
export function computeQualityScore(toolCallSuccessRateAvg: number | null, errorRateAvg: number | null): number | null {
  if (toolCallSuccessRateAvg === null && errorRateAvg === null) return null;

  const successComponent = (toolCallSuccessRateAvg ?? 1) * 80;
  const errorPenalty = Math.min(1, errorRateAvg ?? 0) * 30;
  return Math.max(0, Math.min(100, Math.round(successComponent + 20 - errorPenalty)));
}

const DRIFT_RATIO_THRESHOLD = 1.5; // recent metric more than 50% worse than baseline

/**
 * Compares a recent window's error rate/P99 latency against a longer
 * baseline window. Purely a ratio-threshold heuristic — no seasonality,
 * no statistical significance testing (both real WO-061 concerns).
 */
export function computeDriftStatus(metrics: RecentVsBaselineMetrics): DriftStatus {
  const { recentErrorRateAvg, recentLatencyP99Ms, baselineErrorRateAvg, baselineLatencyP99Ms } = metrics;
  if (baselineErrorRateAvg === null && baselineLatencyP99Ms === null) return "insufficient_data";

  const errorWorse = baselineErrorRateAvg !== null && baselineErrorRateAvg > 0 && (recentErrorRateAvg ?? 0) / baselineErrorRateAvg > DRIFT_RATIO_THRESHOLD;
  const latencyWorse = baselineLatencyP99Ms !== null && baselineLatencyP99Ms > 0 && (recentLatencyP99Ms ?? 0) / baselineLatencyP99Ms > DRIFT_RATIO_THRESHOLD;
  const errorBetter = baselineErrorRateAvg !== null && baselineErrorRateAvg > 0 && (recentErrorRateAvg ?? 0) / baselineErrorRateAvg < 1 / DRIFT_RATIO_THRESHOLD;
  const latencyBetter = baselineLatencyP99Ms !== null && baselineLatencyP99Ms > 0 && (recentLatencyP99Ms ?? 0) / baselineLatencyP99Ms < 1 / DRIFT_RATIO_THRESHOLD;

  if (errorWorse || latencyWorse) return "drifting_up"; // "up" = degrading
  if (errorBetter || latencyBetter) return "drifting_down"; // "down" = improving
  return "stable";
}
