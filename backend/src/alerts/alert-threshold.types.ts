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

export interface AlertEvent {
  id: string;
  tenantId: string;
  agentId: string;
  metricName: AlertMetricName;
  thresholdValue: number;
  actualValue: number;
  severity: AlertSeverity;
  breachTimestamp: Date;
}

/** AC: tenant-level defaults auto-applied to newly registered agents. */
export const DEFAULT_THRESHOLDS: Record<AlertMetricName, { warning: number; critical: number }> = {
  error_rate: { warning: 0.03, critical: 0.05 },
  latency_p99: { warning: 1500, critical: 2000 },
  token_consumption_rate: { warning: 750, critical: 1000 },
  resource_utilization: { warning: 0.8, critical: 0.9 },
};
