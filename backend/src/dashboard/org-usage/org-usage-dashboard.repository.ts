import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { AgentConsumptionEntry, ConsumptionTrendPoint, UsageGranularity } from "./org-usage-dashboard.types";

interface BalanceRow {
  total_credits: string | null;
  total_debits: string | null;
}

interface TrendRow {
  bucket: Date;
  total_credits: string;
}

interface AgentBreakdownRow {
  agent_id: string;
  agent_name: string;
  framework: string;
  credits_consumed: string;
}

const GRANULARITY_TRUNC: Record<UsageGranularity, string> = { daily: "day", weekly: "week", monthly: "month" };

/**
 * `daily_credit_consumption_scoped`/`hourly_credit_consumption_scoped`
 * (migration 058) are materialized views — `WITH NO DATA` at creation, no
 * continuous-refresh scheduler wired in this sandbox (same documented gap
 * as HealthDashboardRepository.refreshHealthAggregate and
 * CreditTransactionRepository.refreshBalances). `refreshAggregates` is
 * the method a real deployment's scheduler would call on the WO's own
 * 1-hour cadence; exposed here for direct invocation by
 * OrgUsagePublisherService and synthetic-event integration tests.
 */
@Injectable()
export class OrgUsageDashboardRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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

  async refreshAggregates(client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    for (const view of ["daily_credit_consumption", "hourly_credit_consumption"]) {
      try {
        await executor.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      } catch {
        // CONCURRENTLY requires a prior non-concurrent refresh to have populated the unique index first (same fallback health/credit-balance aggregates already use).
        await executor.query(`REFRESH MATERIALIZED VIEW ${view}`);
      }
    }
  }

  /**
   * Org-wide balance, computed directly from `credit_transactions`
   * (not `credit_balances_scoped`, which is per-TEAM — the org total is
   * the sum across every team_id, including the null-team rows) — RLS
   * (migration 052) already restricts this to the caller's tenant, and
   * tenant_id is filtered explicitly here too
   * (semgrep raw-sql-missing-tenant-filter).
   */
  async getOrgBalanceTotals(client: Pool | PoolClient | undefined, tenantId: string): Promise<{ totalCredits: number; totalDebits: number }> {
    const executor = client ?? this.pool;
    const result = await executor.query<BalanceRow>(
      "SELECT sum(credits_credit) AS total_credits, sum(credits_debit) AS total_debits FROM credit_transactions WHERE tenant_id = $1",
      [tenantId],
    );
    return {
      totalCredits: Number(result.rows[0]?.total_credits ?? 0),
      totalDebits: Number(result.rows[0]?.total_debits ?? 0),
    };
  }

  async getActiveAgentCount(client: Pool | PoolClient | undefined, tenantId: string): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ count: string }>("SELECT count(*) FROM agents WHERE tenant_id = $1 AND lifecycle_status = 'active'", [tenantId]);
    return Number(result.rows[0].count);
  }

  /** Sum of credits_debit over the last `days` days — the numerator for burn-rate (credits/day). */
  async getRecentConsumptionTotal(client: Pool | PoolClient | undefined, tenantId: string, days: number): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ total: string | null }>(
      "SELECT sum(total_credits) AS total FROM daily_credit_consumption_scoped WHERE tenant_id = $1 AND bucket >= now() - ($2 || ' days')::interval",
      [tenantId, days],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /** Daily/weekly/monthly consumption trend, summed across all agents, for the trend chart. */
  async getConsumptionTrend(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    days: number,
    granularity: UsageGranularity,
  ): Promise<ConsumptionTrendPoint[]> {
    const executor = client ?? this.pool;
    const trunc = GRANULARITY_TRUNC[granularity];
    const result = await executor.query<TrendRow>(
      `SELECT date_trunc('${trunc}', bucket) AS bucket, sum(total_credits) AS total_credits
       FROM daily_credit_consumption_scoped
       WHERE tenant_id = $1 AND bucket >= now() - ($2 || ' days')::interval
       GROUP BY date_trunc('${trunc}', bucket)
       ORDER BY date_trunc('${trunc}', bucket) ASC`,
      [tenantId, days],
    );
    return result.rows.map((row) => ({ date: row.bucket.toISOString(), credits: Number(row.total_credits) }));
  }

  /**
   * Per-agent breakdown for the past `days` days. LEFT JOINs from
   * `agents` (not the aggregate view) so an agent registered but never
   * consuming any credits still appears with zero consumption, per this
   * WO's own edge_cases list — not silently omitted.
   */
  async getAgentBreakdown(client: Pool | PoolClient | undefined, tenantId: string, days: number): Promise<AgentConsumptionEntry[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentBreakdownRow>(
      `SELECT a.id AS agent_id, a.name AS agent_name, a.framework,
              COALESCE(sum(d.total_credits), 0) AS credits_consumed
       FROM agents a
       LEFT JOIN daily_credit_consumption_scoped d
         ON d.tenant_id = a.tenant_id AND d.agent_id = a.id AND d.bucket >= now() - ($2 || ' days')::interval
       WHERE a.tenant_id = $1
       GROUP BY a.id, a.name, a.framework
       ORDER BY credits_consumed DESC, a.name ASC`,
      [tenantId, days],
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      framework: row.framework,
      creditsConsumed: Number(row.credits_consumed),
    }));
  }
}
