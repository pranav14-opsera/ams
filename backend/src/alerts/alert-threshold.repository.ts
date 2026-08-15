import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { AlertMetricName, AlertThresholdConfig } from "./alert-threshold.types";

interface ThresholdRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  metric_name: AlertMetricName;
  warning_threshold: string;
  critical_threshold: string;
  cooldown_seconds: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toDomain(row: ThresholdRow): AlertThresholdConfig {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    metricName: row.metric_name,
    warningThreshold: Number(row.warning_threshold),
    criticalThreshold: Number(row.critical_threshold),
    cooldownSeconds: row.cooldown_seconds,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class AlertThresholdRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    agentId: string,
    fields: { metricName: AlertMetricName; warningThreshold: number; criticalThreshold: number; cooldownSeconds: number; createdBy: string | null },
  ): Promise<AlertThresholdConfig> {
    const executor = client ?? this.pool;
    const result = await executor.query<ThresholdRow>(
      `INSERT INTO alert_threshold_configs (tenant_id, agent_id, metric_name, warning_threshold, critical_threshold, cooldown_seconds, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenantId, agentId, fields.metricName, fields.warningThreshold, fields.criticalThreshold, fields.cooldownSeconds, fields.createdBy],
    );
    return toDomain(result.rows[0]);
  }

  async findByAgentId(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<AlertThresholdConfig[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<ThresholdRow>("SELECT * FROM alert_threshold_configs WHERE tenant_id = $1 AND agent_id = $2 ORDER BY metric_name ASC", [tenantId, agentId]);
    return result.rows.map(toDomain);
  }

  async findOne(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<AlertThresholdConfig | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<ThresholdRow>("SELECT * FROM alert_threshold_configs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async update(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    id: string,
    fields: { warningThreshold?: number; criticalThreshold?: number; cooldownSeconds?: number },
  ): Promise<AlertThresholdConfig | null> {
    const executor = client ?? this.pool;
    const setClauses: string[] = [];
    const params: unknown[] = [tenantId, id];

    if (fields.warningThreshold !== undefined) {
      params.push(fields.warningThreshold);
      setClauses.push(`warning_threshold = $${params.length}`);
    }
    if (fields.criticalThreshold !== undefined) {
      params.push(fields.criticalThreshold);
      setClauses.push(`critical_threshold = $${params.length}`);
    }
    if (fields.cooldownSeconds !== undefined) {
      params.push(fields.cooldownSeconds);
      setClauses.push(`cooldown_seconds = $${params.length}`);
    }
    if (setClauses.length === 0) return this.findOne(executor, tenantId, id);

    setClauses.push("updated_at = now()");
    const result = await executor.query<ThresholdRow>(`UPDATE alert_threshold_configs SET ${setClauses.join(", ")} WHERE tenant_id = $1 AND id = $2 RETURNING *`, params);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async delete(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query("DELETE FROM alert_threshold_configs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** All active (any-agent) thresholds for a tenant — the evaluator's own per-tick read. */
  async findAllForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<AlertThresholdConfig[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<ThresholdRow>("SELECT * FROM alert_threshold_configs WHERE tenant_id = $1", [tenantId]);
    return result.rows.map(toDomain);
  }

  /** Only tenants that actually HAVE at least one threshold configured need a scheduler tick at all — cheaper and more targeted than iterating every provisioned tenant. */
  async findDistinctTenantIds(client?: Pool | PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM alert_threshold_configs");
    return result.rows.map((row) => row.tenant_id);
  }
}
