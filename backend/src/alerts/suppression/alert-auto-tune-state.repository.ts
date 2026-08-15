import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { AlertAutoTuneState } from "./alert-suppression.types";

interface AutoTuneRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  metric_name: string;
  warning_multiplier: string;
  last_tuned_at: Date | null;
  feedback_cursor: Date;
}

function toDomain(row: AutoTuneRow): AlertAutoTuneState {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    metricName: row.metric_name,
    warningMultiplier: Number(row.warning_multiplier),
    lastTunedAt: row.last_tuned_at,
    feedbackCursor: row.feedback_cursor,
  };
}

@Injectable()
export class AlertAutoTuneStateRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByPattern(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string): Promise<AlertAutoTuneState | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AutoTuneRow>("SELECT * FROM alert_auto_tune_state WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = $3", [tenantId, agentId, metricName]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  /** Effective warning multiplier for evaluation — 1.0 (no adjustment) when no auto-tune state exists yet for this pattern, avoiding a round trip through ensureExists for the (common) never-tuned case. */
  async getEffectiveMultiplier(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string): Promise<number> {
    const state = await this.findByPattern(client, tenantId, agentId, metricName);
    return state?.warningMultiplier ?? 1.0;
  }

  /** Batch read for the suppression-metrics endpoint's auto_tuned_count. */
  async countTunedForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ count: string }>("SELECT count(*) AS count FROM alert_auto_tune_state WHERE tenant_id = $1 AND last_tuned_at IS NOT NULL", [tenantId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Applies one tuning step: multiplier *= AUTO_TUNE_STEP_MULTIPLIER,
   * capped at AUTO_TUNE_MAX_MULTIPLIER, and advances feedback_cursor so
   * the SAME feedback never triggers a second tuning pass (see the
   * scheduler for how the cursor is used to only count feedback newer
   * than the last tuning).
   */
  async applyTuningStep(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    agentId: string,
    metricName: string,
    stepMultiplier: number,
    maxMultiplier: number,
    newCursor: Date,
  ): Promise<AlertAutoTuneState> {
    const executor = client ?? this.pool;
    const result = await executor.query<AutoTuneRow>(
      `INSERT INTO alert_auto_tune_state (tenant_id, agent_id, metric_name, warning_multiplier, last_tuned_at, feedback_cursor)
       VALUES ($1, $2, $3, LEAST($4::double precision, $5::double precision), now(), $6)
       ON CONFLICT (tenant_id, agent_id, metric_name) DO UPDATE
         SET warning_multiplier = LEAST(alert_auto_tune_state.warning_multiplier * $4::double precision, $5::double precision),
             last_tuned_at = now(),
             feedback_cursor = $6,
             updated_at = now()
       RETURNING *`,
      [tenantId, agentId, metricName, stepMultiplier, maxMultiplier, newCursor],
    );
    return toDomain(result.rows[0]);
  }
}
