import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { AnomalyBaselineRepository } from "./anomaly-baseline.repository";
import { ANOMALY_METRIC_NAMES, CALIBRATION_PERIOD_DAYS, type AnomalyMetricName, type CalibrationStatus } from "./anomaly-detection.types";

const METRIC_COLUMN: Record<AnomalyMetricName, string> = {
  latency_p99: "latency_p99_ms",
  error_rate: "error_rate_avg",
  token_consumption: "token_consumption_total",
};

const MIN_BUCKETS_FOR_CALIBRATION = 24; // at least a day's worth of 1hr buckets with real data — a 7-day-old agent that's been mostly idle shouldn't calibrate off 2 data points

/**
 * Calibration lifecycle (this WO's own AC): starts on agent registration
 * or anomaly-config creation, checks whether 7 days of active telemetry
 * exist, and computes the initial static baseline (mean/variance) from
 * `agent_metrics_1hr_agg_scoped` (WO-057) — 168 possible hourly buckets
 * over the window is a large-enough, already-tested aggregate source,
 * reused rather than a new query path against raw agent_metrics.
 */
@Injectable()
export class CalibrationService {
  private readonly logger = new Logger(CalibrationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly baselineRepository: AnomalyBaselineRepository,
  ) {}

  /**
   * `agent_metrics_1hr_agg_scoped` (and every other `_scoped` view in this
   * codebase) filters on `current_setting('app.current_tenant', true)::uuid`
   * directly in its own SQL — that's a hard-coded predicate, not an RLS
   * policy, so it runs regardless of role/superuser status and throws
   * ("invalid input syntax for type uuid") if the session variable was
   * never set. Request-scoped callers get this for free from
   * TenantContextMiddleware; AnomalyDetectorService's background
   * scheduler has no request/connection to inherit it from, so any
   * caller that doesn't already pass a scoped `client` gets one set up
   * here — same "acquire a dedicated client, set_config, release"
   * pattern as HealthDashboardRepository.withTenantScope.
   */
  private async withTenantScope<T>(client: Pool | PoolClient | undefined, tenantId: string, fn: (executor: Pool | PoolClient) => Promise<T>): Promise<T> {
    if (client) return fn(client);
    const scoped = await this.pool.connect();
    try {
      await scoped.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
      return await fn(scoped);
    } finally {
      scoped.release();
    }
  }

  async startCalibration(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<void> {
    for (const metricName of ANOMALY_METRIC_NAMES) {
      await this.baselineRepository.ensureStarted(client, tenantId, agentId, metricName);
    }
  }

  getCalibrationStatus(calibrationStartedAt: Date, calibrationCompletedAt: Date | null, now: Date = new Date()): CalibrationStatus {
    if (calibrationCompletedAt) return { calibrating: false, daysRemaining: 0 };

    const elapsedDays = (now.getTime() - calibrationStartedAt.getTime()) / (24 * 60 * 60 * 1000);
    const daysRemaining = Math.max(0, Math.ceil(CALIBRATION_PERIOD_DAYS - elapsedDays));
    return { calibrating: daysRemaining > 0, daysRemaining };
  }

  /**
   * Checks whether the 7-day window has elapsed for this agent+metric
   * and, if so, computes the baseline from real historical aggregate
   * data and marks calibration complete. A no-op (returns false) if
   * still within the window, already completed, or there isn't yet
   * enough real data to trust a baseline computed from it.
   */
  async checkAndCompleteCalibration(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: AnomalyMetricName, now: Date = new Date()): Promise<boolean> {
    const baseline = await this.baselineRepository.findByAgentAndMetric(client, tenantId, agentId, metricName);
    if (!baseline || baseline.calibrationCompletedAt) return false;

    const status = this.getCalibrationStatus(baseline.calibrationStartedAt, null, now);
    if (status.calibrating) return false;

    const column = METRIC_COLUMN[metricName];
    const sinceIso = new Date(now.getTime() - CALIBRATION_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.withTenantScope(client, tenantId, (executor) =>
      executor.query<{ mean: string | null; variance: string | null; sample_count: string }>(
        `SELECT avg(${column}) AS mean, var_pop(${column}) AS variance, count(${column}) AS sample_count
         FROM agent_metrics_1hr_agg_scoped
         WHERE tenant_id = $1 AND agent_id = $2 AND bucket >= $3 AND ${column} IS NOT NULL`,
        [tenantId, agentId, sinceIso],
      ),
    );

    const row = result.rows[0];
    const sampleCount = Number(row?.sample_count ?? 0);
    if (!row || row.mean === null || sampleCount < MIN_BUCKETS_FOR_CALIBRATION) {
      this.logger.warn(`agent ${agentId} metric ${metricName} has only ${sampleCount} historical buckets — deferring calibration completion until more data accumulates`);
      return false;
    }

    await this.baselineRepository.completeCalibration(client, tenantId, agentId, metricName, Number(row.mean), Number(row.variance ?? 0), sampleCount);
    return true;
  }

  /**
   * The most recent hourly-bucket value for one metric — deliberately
   * the SAME column/view (`agent_metrics_1hr_agg_scoped`) the baseline
   * itself was computed from, so AnomalyDetectorService's live
   * evaluation and the calibrated baseline are always in the same unit
   * and granularity. Reusing WO-059's 5-second-bucket snapshot cache
   * here instead would silently compare incompatible granularities
   * (5s-bucket totals vs this baseline's hourly aggregates) — found by
   * reasoning through the unit mismatch before it became a real bug.
   */
  async getLatestMetricValue(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: AnomalyMetricName): Promise<number | null> {
    const column = METRIC_COLUMN[metricName];
    const result = await this.withTenantScope(client, tenantId, (executor) =>
      executor.query<Record<string, string | null>>(`SELECT ${column} AS value FROM agent_metrics_1hr_agg_scoped WHERE tenant_id = $1 AND agent_id = $2 ORDER BY bucket DESC LIMIT 1`, [tenantId, agentId]),
    );
    const value = result.rows[0]?.value;
    return value === null || value === undefined ? null : Number(value);
  }

  /**
   * AC: "Calibrating" badge on the health dashboard with days remaining.
   * An agent is considered still calibrating if ANY of its tracked
   * metrics hasn't completed calibration yet — daysRemaining is the
   * WORST case (max) across them, so the badge never understates how
   * long a caller actually has to wait.
   */
  async getFleetCalibrationStatus(client: Pool | PoolClient | undefined, tenantId: string, agentIds: string[], now: Date = new Date()): Promise<Map<string, CalibrationStatus>> {
    const baselines = await this.baselineRepository.findAllForAgents(client, tenantId, agentIds);
    const statusByAgent = new Map<string, CalibrationStatus>();

    for (const baseline of baselines) {
      const status = this.getCalibrationStatus(baseline.calibrationStartedAt, baseline.calibrationCompletedAt, now);
      const existing = statusByAgent.get(baseline.agentId);
      if (!existing || status.daysRemaining > existing.daysRemaining) {
        statusByAgent.set(baseline.agentId, status);
      }
    }

    return statusByAgent;
  }
}
