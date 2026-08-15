import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { AgentFramework } from "../agents/dto/create-agent.dto";
import type { AgentLifecycleStatus } from "../agents/dto/list-agents-query.dto";

export interface AgentHealthRow {
  id: string;
  tenantId: string;
  teamId: string | null;
  name: string;
  framework: AgentFramework;
  lifecycleStatus: AgentLifecycleStatus;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  errorRateAvg: number | null;
  tokenConsumptionTotal: number | null;
  toolCallSuccessRateAvg: number | null;
  metricsBucket: Date | null;
}

export interface AgentHealthFilters {
  teamIds?: string[] | null;
  framework?: AgentFramework;
  lifecycleStatus?: AgentLifecycleStatus;
  limit: number;
  offset: number;
}

/**
 * `agent_health_5s_agg_scoped` (migration 036) is a materialized view —
 * `WITH NO DATA` at creation, no continuous-refresh scheduler wired in
 * this sandbox (same "not wired to a live cron here" gap as
 * JwtKeyService.rotateIfDue and migration 007/016's own jobs). A real
 * deployment refreshes it on an interval; `refreshHealthAggregate` is the
 * method that job would call, exposed here for direct invocation by
 * synthetic-event integration tests and HealthMetricsPublisherService.
 */
@Injectable()
export class HealthDashboardRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * `agent_health_5s_agg_scoped` filters by `current_setting('app.current_tenant', true)`
   * (migration 006's RLS pattern) — set per-request by TenantContextMiddleware
   * for a real REST call, but HealthMetricsPublisherService runs OUTSIDE any
   * request (a scheduler tick / synthetic-event test), so nothing has set
   * it. This opens its own scoped transaction the same way, for callers
   * with no request context to inherit one from.
   */
  async withTenantScope<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async refreshHealthAggregate(client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    try {
      await executor.query("REFRESH MATERIALIZED VIEW CONCURRENTLY agent_health_5s_agg");
    } catch {
      // CONCURRENTLY requires the unique index to have been populated by
      // at least one non-concurrent refresh first (migration 007/036's
      // own documented WITH NO DATA constraint) — same fallback the
      // existing aggregate integration tests already use.
      await executor.query("REFRESH MATERIALIZED VIEW agent_health_5s_agg");
    }
  }

  /**
   * One row per agent, joined to its MOST RECENT health-aggregate bucket
   * (LEFT JOIN LATERAL — an agent with no metrics yet still appears, with
   * null metric columns, per computeHealthStatus's own "defaults to
   * active" handling). tenant_id filtered explicitly on both sides of the
   * join (semgrep raw-sql-missing-tenant-filter), not left to RLS alone.
   */
  async findFleetHealth(client: Pool | PoolClient | undefined, tenantId: string, filters: AgentHealthFilters): Promise<{ rows: AgentHealthRow[]; total: number }> {
    const executor = client ?? this.pool;
    const conditions = ["a.tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filters.teamIds) {
      if (filters.teamIds.length === 0) {
        return { rows: [], total: 0 };
      }
      params.push(filters.teamIds);
      conditions.push(`a.team_id = ANY($${params.length}::uuid[])`);
    }
    if (filters.framework) {
      params.push(filters.framework);
      conditions.push(`a.framework = $${params.length}`);
    }
    if (filters.lifecycleStatus) {
      params.push(filters.lifecycleStatus);
      conditions.push(`a.lifecycle_status = $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");
    const countResult = await executor.query<{ count: string }>(`SELECT count(*) FROM agents a WHERE ${whereClause}`, params);

    const rows = await executor.query(
      `SELECT
         a.id, a.tenant_id, a.team_id, a.name, a.framework, a.lifecycle_status,
         m.latency_p50_ms, m.latency_p99_ms, m.error_rate_avg, m.token_consumption_total, m.tool_call_success_rate_avg, m.bucket
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT latency_p50_ms, latency_p99_ms, error_rate_avg, token_consumption_total, tool_call_success_rate_avg, bucket
         FROM agent_health_5s_agg_scoped h
         WHERE h.tenant_id = a.tenant_id AND h.agent_id = a.id
         ORDER BY h.bucket DESC
         LIMIT 1
       ) m ON true
       WHERE ${whereClause}
       ORDER BY a.name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );

    return {
      total: Number(countResult.rows[0].count),
      rows: rows.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        teamId: row.team_id,
        name: row.name,
        framework: row.framework,
        lifecycleStatus: row.lifecycle_status,
        latencyP50Ms: row.latency_p50_ms,
        latencyP99Ms: row.latency_p99_ms,
        errorRateAvg: row.error_rate_avg,
        tokenConsumptionTotal: row.token_consumption_total ?? null,
        toolCallSuccessRateAvg: row.tool_call_success_rate_avg ?? null,
        metricsBucket: row.bucket ?? null,
      })),
    };
  }
}
