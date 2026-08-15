import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { ComponentDeltas, DriftEvent } from "./drift-detection.types";

interface DriftEventRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  detected_at: Date;
  ks_statistic: string;
  p_value: string;
  baseline_mean: string;
  current_mean: string;
  degradation_magnitude: string;
  affected_components: ComponentDeltas;
  consecutive_window_count: number;
}

function toDomain(row: DriftEventRow): DriftEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    detectedAt: row.detected_at,
    ksStatistic: Number(row.ks_statistic),
    pValue: Number(row.p_value),
    baselineMean: Number(row.baseline_mean),
    currentMean: Number(row.current_mean),
    degradationMagnitude: Number(row.degradation_magnitude),
    affectedComponents: row.affected_components,
    consecutiveWindowCount: row.consecutive_window_count,
  };
}

/** Immutable — INSERT and SELECT only, one row per genuine (3-consecutive-window) drift alert, the historical/audit record (AC: "including full statistical evidence"). */
@Injectable()
export class DriftEventRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    agentId: string,
    fields: {
      ksStatistic: number;
      pValue: number;
      baselineMean: number;
      currentMean: number;
      degradationMagnitude: number;
      affectedComponents: ComponentDeltas;
      consecutiveWindowCount: number;
    },
  ): Promise<DriftEvent> {
    const executor = client ?? this.pool;
    const result = await executor.query<DriftEventRow>(
      `INSERT INTO drift_events (tenant_id, agent_id, ks_statistic, p_value, baseline_mean, current_mean, degradation_magnitude, affected_components, consecutive_window_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [tenantId, agentId, fields.ksStatistic, fields.pValue, fields.baselineMean, fields.currentMean, fields.degradationMagnitude, JSON.stringify(fields.affectedComponents), fields.consecutiveWindowCount],
    );
    return toDomain(result.rows[0]);
  }

  async findHistory(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sinceIso: string): Promise<DriftEvent[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<DriftEventRow>("SELECT * FROM drift_events WHERE tenant_id = $1 AND agent_id = $2 AND detected_at >= $3 ORDER BY detected_at DESC", [tenantId, agentId, sinceIso]);
    return result.rows.map(toDomain);
  }

  async findMostRecent(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<DriftEvent | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<DriftEventRow>("SELECT * FROM drift_events WHERE tenant_id = $1 AND agent_id = $2 ORDER BY detected_at DESC LIMIT 1", [tenantId, agentId]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }
}
