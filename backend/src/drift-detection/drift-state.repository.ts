import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { DriftDetectionState } from "./drift-detection.types";

interface StateRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  consecutive_drift_count: number;
  last_evaluated_at: Date | null;
  last_ks_statistic: string | null;
  last_p_value: string | null;
}

function toDomain(row: StateRow): DriftDetectionState {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    consecutiveDriftCount: row.consecutive_drift_count,
    lastEvaluatedAt: row.last_evaluated_at,
    lastKsStatistic: row.last_ks_statistic === null ? null : Number(row.last_ks_statistic),
    lastPValue: row.last_p_value === null ? null : Number(row.last_p_value),
  };
}

/** Durable (Postgres) copy of the consecutive-drift-window counter — Redis is the hot per-tick path (DriftStateCacheService), this table is what's restored on a cache miss/restart. */
@Injectable()
export class DriftStateRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async find(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<DriftDetectionState | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<StateRow>("SELECT * FROM drift_detection_state WHERE tenant_id = $1 AND agent_id = $2", [tenantId, agentId]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async upsert(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, consecutiveDriftCount: number, ksStatistic: number, pValue: number, evaluatedAt: Date): Promise<DriftDetectionState> {
    const executor = client ?? this.pool;
    const result = await executor.query<StateRow>(
      `INSERT INTO drift_detection_state (tenant_id, agent_id, consecutive_drift_count, last_evaluated_at, last_ks_statistic, last_p_value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, agent_id) DO UPDATE
         SET consecutive_drift_count = $3, last_evaluated_at = $4, last_ks_statistic = $5, last_p_value = $6, updated_at = now()
       RETURNING *`,
      [tenantId, agentId, consecutiveDriftCount, evaluatedAt, ksStatistic, pValue],
    );
    return toDomain(result.rows[0]);
  }
}
