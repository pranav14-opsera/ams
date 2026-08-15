import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { AlertSnoozeConfig } from "./alert-suppression.types";

interface SnoozeRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  metric_name: string;
  snoozed_until: Date;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toDomain(row: SnoozeRow): AlertSnoozeConfig {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    metricName: row.metric_name,
    snoozedUntil: row.snoozed_until,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class AlertSnoozeRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** A new snooze on the same pattern replaces (extends/shortens) the existing one — never stacks. */
  async upsert(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string, snoozedUntil: Date, createdBy: string | null): Promise<AlertSnoozeConfig> {
    const executor = client ?? this.pool;
    const result = await executor.query<SnoozeRow>(
      `INSERT INTO alert_snooze_configs (tenant_id, agent_id, metric_name, snoozed_until, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, agent_id, metric_name) DO UPDATE SET snoozed_until = $4, created_by = $5, updated_at = now()
       RETURNING *`,
      [tenantId, agentId, metricName, snoozedUntil, createdBy],
    );
    return toDomain(result.rows[0]);
  }

  async findById(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<AlertSnoozeConfig | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<SnoozeRow>("SELECT * FROM alert_snooze_configs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async findActive(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string, now: Date = new Date()): Promise<AlertSnoozeConfig | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<SnoozeRow>(
      "SELECT * FROM alert_snooze_configs WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = $3 AND snoozed_until > $4",
      [tenantId, agentId, metricName, now],
    );
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async remove(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<AlertSnoozeConfig | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<SnoozeRow>("DELETE FROM alert_snooze_configs WHERE tenant_id = $1 AND id = $2 RETURNING *", [tenantId, id]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  /** AC: "suppressed_count" in the suppression metrics response — currently-active snoozes for the tenant. */
  async countActiveForTenant(client: Pool | PoolClient | undefined, tenantId: string, now: Date = new Date()): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ count: string }>("SELECT count(*) AS count FROM alert_snooze_configs WHERE tenant_id = $1 AND snoozed_until > $2", [tenantId, now]);
    return Number(result.rows[0]?.count ?? 0);
  }
}
