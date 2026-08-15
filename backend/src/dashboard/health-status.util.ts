import type { AgentLifecycleStatus } from "../agents/dto/list-agents-query.dto";

export const AGENT_HEALTH_STATUSES = ["active", "paused", "degraded", "error", "retired"] as const;
export type AgentHealthStatus = (typeof AGENT_HEALTH_STATUSES)[number];

export interface HealthThresholds {
  errorRateErrorThreshold: number;
  errorRateDegradedThreshold: number;
  latencyP99DegradedMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  errorRateErrorThreshold: 0.05,
  errorRateDegradedThreshold: 0.01,
  latencyP99DegradedMs: 5_000,
};

/**
 * AC's unified status enum (Active/Paused/Degraded/Error/Retired) mixes
 * two different sources: lifecycle_status (agents table, operator-driven)
 * and live health metrics (agent_health_5s_agg, telemetry-driven).
 * Lifecycle wins outright for paused/retired/decommissioned — an agent an
 * operator explicitly paused shouldn't flip to "degraded" just because
 * its last-seen metrics were bad before it was paused. For every other
 * lifecycle state, live metrics (when present) determine Active vs
 * Degraded vs Error; an agent with no metrics yet (freshly connecting, or
 * metrics not refreshed since it started) defaults to Active rather than
 * a fourth "unknown" state the AC never asked for.
 */
export function computeHealthStatus(
  lifecycleStatus: AgentLifecycleStatus,
  metrics: { errorRateAvg: number | null; latencyP99Ms: number | null } | null,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): AgentHealthStatus {
  if (lifecycleStatus === "paused") return "paused";
  if (lifecycleStatus === "retired" || lifecycleStatus === "decommissioned") return "retired";
  if (!metrics) return "active";

  const errorRate = metrics.errorRateAvg ?? 0;
  const latencyP99 = metrics.latencyP99Ms ?? 0;

  if (errorRate > thresholds.errorRateErrorThreshold) return "error";
  if (errorRate > thresholds.errorRateDegradedThreshold || latencyP99 > thresholds.latencyP99DegradedMs) return "degraded";
  return "active";
}

export const HEALTH_STATUS_SEVERITY_RANK: Record<AgentHealthStatus, number> = {
  error: 0,
  degraded: 1,
  active: 2,
  paused: 3,
  retired: 4,
};
