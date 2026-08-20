import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { TeamRef, TeamUsageGranularity } from "./team-usage-dashboard.types";

/** Repository-layer filters — `frameworks` here is already translated to DB-stored values ("generic_rest", not the wire "rest") by the service layer before this is called. */
export interface TeamUsageRepositoryFilters {
  agentIds?: string[];
  actionTypes?: string[];
  frameworks?: string[];
}

interface TeamRow {
  id: string;
  name: string;
}

interface ConsumptionRow {
  bucket: Date;
  agent_id: string;
  agent_name: string;
  framework: string;
  credits: string;
}

const GRANULARITY_TRUNC: Record<TeamUsageGranularity, string> = { daily: "day", weekly: "week" };

/**
 * Team-scoped consumption queries. Deliberately queries
 * `credit_transactions` directly rather than migration 058's
 * `daily_credit_consumption_scoped`/`hourly_credit_consumption_scoped`
 * materialized views: those views (a) have no `team_id` column at all
 * (only tenant_id/agent_id/bucket — team scoping would need a join back
 * to `agents` anyway) and (b) have no `action_type`/`framework` dimension
 * to filter or group by, both of which this WO's own filter panel AC
 * requires. Re-deriving those two extra dimensions from the aggregate
 * views isn't possible without changing their shape (out of this WO's
 * scope — they're WO-074's), so this queries the same underlying ledger
 * those views are themselves built from (`credit_transactions`,
 * migration 052) instead of duplicating a NEW aggregation layer. Every
 * filter is bound as a parameterized value ($n / = ANY($n::...[])),
 * never string-concatenated (OWASP A05).
 */
@Injectable()
export class TeamUsageDashboardRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getTeam(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<TeamRef | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<TeamRow>("SELECT id, name FROM teams WHERE tenant_id = $1 AND id = $2", [tenantId, teamId]);
    return result.rows[0] ?? null;
  }

  /** Every team in the tenant — backs the Platform Administrator team selector (AC 6). */
  async listTeamsForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<TeamRef[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<TeamRow>("SELECT id, name FROM teams WHERE tenant_id = $1 ORDER BY name ASC", [tenantId]);
    return result.rows;
  }

  /** Just the teams a specific user belongs to, with names — backs the Team Lead's own (possibly multi-team) selector (edge_case: "Team Lead in multiple teams sees only their teams in selector"). */
  async listTeamsForUser(client: Pool | PoolClient | undefined, tenantId: string, userId: string): Promise<TeamRef[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<TeamRow>(
      `SELECT t.id, t.name FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.tenant_id = $1 AND tm.user_id = $2 ORDER BY t.name ASC`,
      [tenantId, userId],
    );
    return result.rows;
  }

  /**
   * Agents assigned to this team — counted regardless of lifecycle_status
   * (unlike OrgUsageDashboardRepository.getActiveAgentCount's
   * active-only count): this WO's own AC 2 just says "agent count", and a
   * team lead reasonably expects a paused/retired agent to still count
   * as part of their team's roster, not silently vanish from the KPI.
   */
  async getTeamAgentCount(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ count: string }>("SELECT count(*) FROM agents WHERE tenant_id = $1 AND team_id = $2", [tenantId, teamId]);
    return Number(result.rows[0].count);
  }

  /** Sum of credits_debit for this team over the trailing `days` days — the numerator for burn-rate. */
  async getRecentTeamConsumptionTotal(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, days: number): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ total: string | null }>(
      "SELECT sum(credits_debit) AS total FROM credit_transactions WHERE tenant_id = $1 AND team_id = $2 AND occurred_at >= now() - ($3 || ' days')::interval",
      [tenantId, teamId, days],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * Per-agent, per-bucket consumption rows for this team over `days`
   * days, with every filter panel dimension applied. The service layer
   * derives BOTH the consumption trend (summed across agents, per
   * bucket) and the agent comparison (summed across buckets, per agent)
   * from these same rows — one query, two shapes, always consistent with
   * each other under the same filter set.
   */
  async getTeamConsumptionRows(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    teamId: string,
    days: number,
    granularity: TeamUsageGranularity,
    filters: TeamUsageRepositoryFilters,
  ): Promise<ConsumptionRow[]> {
    const executor = client ?? this.pool;
    const trunc = GRANULARITY_TRUNC[granularity];

    const conditions = ["ct.tenant_id = $1", "ct.team_id = $2", "ct.occurred_at >= now() - ($3 || ' days')::interval"];
    const params: unknown[] = [tenantId, teamId, days];

    if (filters.agentIds && filters.agentIds.length > 0) {
      params.push(filters.agentIds);
      conditions.push(`ct.agent_id = ANY($${params.length}::uuid[])`);
    }
    if (filters.actionTypes && filters.actionTypes.length > 0) {
      params.push(filters.actionTypes);
      conditions.push(`ct.action_type = ANY($${params.length}::text[])`);
    }
    if (filters.frameworks && filters.frameworks.length > 0) {
      params.push(filters.frameworks);
      conditions.push(`a.framework = ANY($${params.length}::text[])`);
    }

    const sql = `
      SELECT date_trunc('${trunc}', ct.occurred_at) AS bucket, a.id AS agent_id, a.name AS agent_name, a.framework, sum(ct.credits_debit) AS credits
      FROM credit_transactions ct
      JOIN agents a ON a.id = ct.agent_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY date_trunc('${trunc}', ct.occurred_at), a.id, a.name, a.framework
      ORDER BY bucket ASC
    `;

    const result = await executor.query<ConsumptionRow>(sql, params);
    return result.rows;
  }

  /**
   * Agents assigned to the team but with zero matching consumption
   * (or not appearing in `getTeamConsumptionRows` at all under the
   * current filters) still need to appear in the agent comparison —
   * same "LEFT JOIN FROM agents, never silently drop a zero-consumption
   * agent" rule OrgUsageDashboardRepository.getAgentBreakdown already
   * establishes. Framework filter (the only agent-level filter) is
   * applied here too so a filtered-out agent doesn't reappear as a
   * phantom zero row.
   */
  async getTeamAgentRoster(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, frameworks: string[] | undefined): Promise<Array<{ id: string; name: string; framework: string }>> {
    const executor = client ?? this.pool;
    const conditions = ["tenant_id = $1", "team_id = $2"];
    const params: unknown[] = [tenantId, teamId];
    if (frameworks && frameworks.length > 0) {
      params.push(frameworks);
      conditions.push(`framework = ANY($${params.length}::text[])`);
    }
    const result = await executor.query<{ id: string; name: string; framework: string }>(`SELECT id, name, framework FROM agents WHERE ${conditions.join(" AND ")}`, params);
    return result.rows;
  }
}
