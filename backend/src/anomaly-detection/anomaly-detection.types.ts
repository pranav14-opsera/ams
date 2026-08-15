export const ANOMALY_METRIC_NAMES = ["latency_p99", "error_rate", "token_consumption"] as const;
export type AnomalyMetricName = (typeof ANOMALY_METRIC_NAMES)[number];

export const SENSITIVITY_LEVELS = ["low", "medium", "high"] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

/** AC: low=4 sigma, medium=3 sigma (the widely-used default), high=2 sigma. */
export const SIGMA_THRESHOLD_BY_SENSITIVITY: Record<SensitivityLevel, number> = {
  low: 4,
  medium: 3,
  high: 2,
};

export const CALIBRATION_PERIOD_DAYS = 7;

export interface DriftDetectionConfig {
  id: string;
  tenantId: string;
  agentId: string;
  sensitivity: SensitivityLevel;
  enabled: boolean;
}

export interface AnomalyBaseline {
  id: string;
  tenantId: string;
  agentId: string;
  metricName: AnomalyMetricName;
  ewmaMean: number | null;
  ewmaVariance: number | null;
  baselineMean: number | null;
  baselineVariance: number | null;
  observationCount: number;
  calibrationStartedAt: Date;
  calibrationCompletedAt: Date | null;
}

export interface CalibrationStatus {
  calibrating: boolean;
  daysRemaining: number;
}
