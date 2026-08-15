export const ALERT_METRIC_NAMES = ["error_rate", "latency_p99", "token_consumption_rate", "resource_utilization"] as const;
export type AlertMetricName = (typeof ALERT_METRIC_NAMES)[number];

export const ALERT_SEVERITIES = ["warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface AlertThresholdConfig {
  id: string;
  tenantId: string;
  agentId: string;
  metricName: AlertMetricName;
  warningThreshold: number;
  criticalThreshold: number;
  cooldownSeconds: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const DETECTION_METHODS = ["threshold", "anomaly"] as const;
export type DetectionMethod = (typeof DETECTION_METHODS)[number];

/** AC: every anomaly alert event carries statistical evidence — expected value, actual value, deviation magnitude, and which algorithm produced it. Absent (null) on threshold-triggered events. */
export interface StatisticalEvidence {
  expectedValue: number;
  actualValue: number;
  deviationSigma: number;
  algorithmUsed: "ewma" | "zscore";
}

export interface AlertEvent {
  id: string;
  tenantId: string;
  agentId: string;
  /**
   * A plain string, not AlertMetricName — alert_events.metric_name
   * (migration 046) has no CHECK constraint restricting its values
   * (unlike alert_threshold_configs' own metric_name column), and WO-061's
   * anomaly detector writes a different metric-name vocabulary
   * ("token_consumption", not "token_consumption_rate") into the SAME
   * table alongside WO-059's threshold-triggered events.
   */
  metricName: string;
  thresholdValue: number;
  actualValue: number;
  severity: AlertSeverity;
  breachTimestamp: Date;
  detectionMethod: DetectionMethod;
  statisticalEvidence: StatisticalEvidence | null;
}

/** AC: tenant-level defaults auto-applied to newly registered agents. */
export const DEFAULT_THRESHOLDS: Record<AlertMetricName, { warning: number; critical: number }> = {
  error_rate: { warning: 0.03, critical: 0.05 },
  latency_p99: { warning: 1500, critical: 2000 },
  token_consumption_rate: { warning: 750, critical: 1000 },
  resource_utilization: { warning: 0.8, critical: 0.9 },
};
