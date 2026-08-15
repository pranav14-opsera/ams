import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { AUTO_TUNE_WINDOW_DAYS, type FalsePositiveFeedback, type FeedbackType, type PatternFeedbackCounts } from "./alert-suppression.types";

interface FeedbackRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  alert_event_id: string;
  metric_name: string;
  feedback_type: FeedbackType;
  created_by: string | null;
  created_at: Date;
}

function toDomain(row: FeedbackRow): FalsePositiveFeedback {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    alertEventId: row.alert_event_id,
    metricName: row.metric_name,
    feedbackType: row.feedback_type,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

@Injectable()
export class FalsePositiveFeedbackRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** One-click feedback is idempotent per alert (unique_feedback_per_alert_event) — resubmitting corrects the prior verdict rather than accumulating duplicates. */
  async submit(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    agentId: string,
    alertEventId: string,
    metricName: string,
    feedbackType: FeedbackType,
    createdBy: string | null,
  ): Promise<FalsePositiveFeedback> {
    const executor = client ?? this.pool;
    const result = await executor.query<FeedbackRow>(
      `INSERT INTO false_positive_feedback (tenant_id, agent_id, alert_event_id, metric_name, feedback_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (alert_event_id) DO UPDATE SET feedback_type = $5, created_by = $6, created_at = now()
       RETURNING *`,
      [tenantId, agentId, alertEventId, metricName, feedbackType, createdBy],
    );
    return toDomain(result.rows[0]);
  }

  /** Aggregated counts for one agent+metric pattern within a trailing window — the auto-tune trigger's own evidence. */
  async getPatternFeedback(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string, windowDays: number = AUTO_TUNE_WINDOW_DAYS, since?: Date): Promise<PatternFeedbackCounts> {
    const executor = client ?? this.pool;
    const sinceIso = since ?? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const result = await executor.query<{ feedback_type: FeedbackType; count: string }>(
      `SELECT feedback_type, count(*) AS count FROM false_positive_feedback
       WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = $3 AND created_at >= $4
       GROUP BY feedback_type`,
      [tenantId, agentId, metricName, sinceIso],
    );
    let falsePositiveCount = 0;
    let confirmedCount = 0;
    for (const row of result.rows) {
      if (row.feedback_type === "false_positive") falsePositiveCount = Number(row.count);
      else confirmedCount = Number(row.count);
    }
    return { falsePositiveCount, confirmedCount };
  }

  /** Every distinct agent+metric pattern with at least one feedback entry within the window — the auto-tune scheduler's own candidate list, one tenant-wide query rather than iterating every threshold config. */
  async findDistinctPatternsWithFeedback(client: Pool | PoolClient | undefined, tenantId: string, since: Date): Promise<Array<{ agentId: string; metricName: string }>> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ agent_id: string; metric_name: string }>(
      `SELECT DISTINCT agent_id, metric_name FROM false_positive_feedback WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, since],
    );
    return result.rows.map((row) => ({ agentId: row.agent_id, metricName: row.metric_name }));
  }

  async findDistinctTenantIds(client?: Pool | PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM false_positive_feedback");
    return result.rows.map((row) => row.tenant_id);
  }

  async countForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ count: string }>("SELECT count(*) AS count FROM false_positive_feedback WHERE tenant_id = $1", [tenantId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async falsePositiveRateForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ feedback_type: FeedbackType; count: string }>(
      "SELECT feedback_type, count(*) AS count FROM false_positive_feedback WHERE tenant_id = $1 GROUP BY feedback_type",
      [tenantId],
    );
    let falsePositive = 0;
    let total = 0;
    for (const row of result.rows) {
      total += Number(row.count);
      if (row.feedback_type === "false_positive") falsePositive = Number(row.count);
    }
    return total === 0 ? 0 : falsePositive / total;
  }
}
