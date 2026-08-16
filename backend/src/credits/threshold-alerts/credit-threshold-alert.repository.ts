import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { CreditAlert, CreditAlertThresholdLevel } from "./credit-threshold-alert.types";

interface AlertRow {
  id: string;
  tenant_id: string;
  team_id: string;
  threshold_level: number;
  consumption_percentage: string;
  effective_month: number;
  effective_year: number;
  generated_at: Date;
}

function toDomain(row: AlertRow): CreditAlert {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    thresholdLevel: row.threshold_level as CreditAlertThresholdLevel,
    consumptionPercentage: Number(row.consumption_percentage),
    effectiveMonth: row.effective_month,
    effectiveYear: row.effective_year,
    generatedAt: row.generated_at,
  };
}

@Injectable()
export class CreditThresholdAlertRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * AC: "at most once per team per effective period" per threshold —
   * `ON CONFLICT DO NOTHING` on the unique (tenant, team, threshold,
   * period) index makes this atomically idempotent: returns the newly
   * created row, or null if one already existed (a duplicate — the
   * caller must NOT re-deliver in that case).
   */
  async tryCreateAlert(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, thresholdLevel: CreditAlertThresholdLevel, consumptionPercentage: number, month: number, year: number): Promise<CreditAlert | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AlertRow>(
      `INSERT INTO credit_alerts (tenant_id, team_id, threshold_level, consumption_percentage, effective_month, effective_year)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, team_id, threshold_level, effective_month, effective_year) DO NOTHING
       RETURNING *`,
      [tenantId, teamId, thresholdLevel, consumptionPercentage, month, year],
    );
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async findForPeriod(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, month: number, year: number): Promise<CreditAlert[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<AlertRow>("SELECT * FROM credit_alerts WHERE tenant_id = $1 AND team_id = $2 AND effective_month = $3 AND effective_year = $4 ORDER BY threshold_level", [
      tenantId,
      teamId,
      month,
      year,
    ]);
    return result.rows.map(toDomain);
  }

  async getTeamName(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<string | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ name: string }>("SELECT name FROM teams WHERE tenant_id = $1 AND id = $2", [tenantId, teamId]);
    return result.rows[0]?.name ?? null;
  }

  /** users.role is the JIT-provisioned, IdP-group-derived platform role (migration 023) — the only place a user's role is actually queryable in this schema. */
  async findFinanceManagerEmails(client: Pool | PoolClient | undefined, tenantId: string): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ email: string }>("SELECT email FROM users WHERE tenant_id = $1 AND role = 'finance_manager' AND status = 'active'", [tenantId]);
    return result.rows.map((row) => row.email);
  }

  /** team_members.role = 'lead' identifies a team's lead(s) — there is no separate "team lead" platform role; team-level leadership is a team_members attribute, distinct from users.role's platform-wide role. */
  async findTeamLeadEmails(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ email: string }>(
      `SELECT u.email FROM team_members tm
       JOIN users u ON u.id = tm.user_id AND u.tenant_id = tm.tenant_id
       WHERE tm.tenant_id = $1 AND tm.team_id = $2 AND tm.role = 'lead' AND u.status = 'active'`,
      [tenantId, teamId],
    );
    return result.rows.map((row) => row.email);
  }
}
