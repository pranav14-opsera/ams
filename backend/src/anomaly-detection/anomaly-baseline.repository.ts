import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { AnomalyBaseline, AnomalyMetricName } from "./anomaly-detection.types";

interface AnomalyBaselineRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  metric_name: AnomalyMetricName;
  ewma_mean: string | null;
  ewma_variance: string | null;
  baseline_mean: string | null;
  baseline_variance: string | null;
  observation_count: number;
  calibration_started_at: Date;
  calibration_completed_at: Date | null;
}

function toDomain(row: AnomalyBaselineRow): AnomalyBaseline {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    metricName: row.metric_name,
    ewmaMean: row.ewma_mean === null ? null : Number(row.ewma_mean),
    ewmaVariance: row.ewma_variance === null ? null : Number(row.ewma_variance),
    baselineMean: row.baseline_mean === null ? null : Number(row.baseline_mean),
    baselineVariance: row.baseline_variance === null ? null : Number(row.baseline_variance),
    observationCount: row.observation_count,
    calibrationStartedAt: row.calibration_started_at,
    calibrationCompletedAt: row.calibration_completed_at,
  };
}

@Injectable()
export class AnomalyBaselineRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Starts (or no-ops if already started) calibration tracking for one agent+metric — called on agent registration / anomaly config creation, per this WO's AC. */
  async ensureStarted(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: AnomalyMetricName): Promise<AnomalyBaseline> {
    const executor = client ?? this.pool;
    const result = await executor.query<AnomalyBaselineRow>(
      `INSERT INTO anomaly_baselines (tenant_id, agent_id, metric_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, agent_id, metric_name) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       RETURNING *`,
      [tenantId, agentId, metricName],
    );
    return toDomain(result.rows[0]);
  }

  async findByAgentAndMetric(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: AnomalyMetricName): Promise<AnomalyBaseline | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AnomalyBaselineRow>("SELECT * FROM anomaly_baselines WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = $3", [tenantId, agentId, metricName]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async findAllByAgent(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<AnomalyBaseline[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<AnomalyBaselineRow>("SELECT * FROM anomaly_baselines WHERE tenant_id = $1 AND agent_id = $2", [tenantId, agentId]);
    return result.rows.map(toDomain);
  }

  /** Batch read for the fleet-health dashboard's "Calibrating" badge (AC) — one query for every agent on the current page, not N+1. */
  async findAllForAgents(client: Pool | PoolClient | undefined, tenantId: string, agentIds: string[]): Promise<AnomalyBaseline[]> {
    if (agentIds.length === 0) return [];
    const executor = client ?? this.pool;
    const result = await executor.query<AnomalyBaselineRow>("SELECT * FROM anomaly_baselines WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[])", [tenantId, agentIds]);
    return result.rows.map(toDomain);
  }

  /** Calibration completion: sets the static baseline mean/variance computed from the 7-day historical window, seeds the EWMA state from the same baseline, and stamps calibration_completed_at. */
  async completeCalibration(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    agentId: string,
    metricName: AnomalyMetricName,
    baselineMean: number,
    baselineVariance: number,
    observationCount: number,
  ): Promise<AnomalyBaseline> {
    const executor = client ?? this.pool;
    const result = await executor.query<AnomalyBaselineRow>(
      `UPDATE anomaly_baselines
       SET baseline_mean = $4, baseline_variance = $5, ewma_mean = $4, ewma_variance = $5, observation_count = $6, calibration_completed_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = $3
       RETURNING *`,
      [tenantId, agentId, metricName, baselineMean, baselineVariance, observationCount],
    );
    return toDomain(result.rows[0]);
  }

  /** Persists the running EWMA state after each evaluation tick (WO-061's own AC: Redis-cached EWMA state — Postgres is the durable copy restored on process restart / read for the baseline view, Redis is the hot per-tick read/write path, see AnomalyDetectorService). */
  async updateEwmaState(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: AnomalyMetricName, ewmaMean: number, ewmaVariance: number, observationCount: number): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      "UPDATE anomaly_baselines SET ewma_mean = $4, ewma_variance = $5, observation_count = $6, updated_at = now() WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = $3",
      [tenantId, agentId, metricName, ewmaMean, ewmaVariance, observationCount],
    );
  }
}
