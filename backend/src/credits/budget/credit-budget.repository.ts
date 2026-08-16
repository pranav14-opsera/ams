import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { AllocateBudgetRequest, CreditBudget, OrganizationCreditPool } from "./credit-budget.types";

interface PoolRow {
  id: string;
  tenant_id: string;
  total_credits: number;
  effective_month: number;
  effective_year: number;
}

interface BudgetRow {
  id: string;
  tenant_id: string;
  team_id: string;
  allocated_credits: number;
  alert_threshold_75: boolean;
  alert_threshold_90: boolean;
  hard_cap: number | null;
  effective_month: number;
  effective_year: number;
  created_by: string | null;
}

function toPoolDomain(row: PoolRow): OrganizationCreditPool {
  return { id: row.id, tenantId: row.tenant_id, totalCredits: row.total_credits, effectiveMonth: row.effective_month, effectiveYear: row.effective_year };
}

function toBudgetDomain(row: BudgetRow): CreditBudget {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    allocatedCredits: row.allocated_credits,
    alertThreshold75: row.alert_threshold_75,
    alertThreshold90: row.alert_threshold_90,
    hardCap: row.hard_cap,
    effectiveMonth: row.effective_month,
    effectiveYear: row.effective_year,
    createdBy: row.created_by,
  };
}

@Injectable()
export class CreditBudgetRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Provisioning the org's own credit pool is out of THIS WO's own endpoint list (AC only specifies allocate/budgets read endpoints) — a separate billing/procurement process is expected to call this. Upsert so re-running it (e.g. a pool top-up) is safe. */
  async upsertPool(client: Pool | PoolClient | undefined, tenantId: string, month: number, year: number, totalCredits: number): Promise<OrganizationCreditPool> {
    const executor = client ?? this.pool;
    const result = await executor.query<PoolRow>(
      `INSERT INTO organization_credit_pools (tenant_id, total_credits, effective_month, effective_year)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, effective_month, effective_year) DO UPDATE SET total_credits = $2, updated_at = now()
       RETURNING *`,
      [tenantId, totalCredits, month, year],
    );
    return toPoolDomain(result.rows[0]);
  }

  async findPool(client: Pool | PoolClient | undefined, tenantId: string, month: number, year: number): Promise<OrganizationCreditPool | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<PoolRow>("SELECT * FROM organization_credit_pools WHERE tenant_id = $1 AND effective_month = $2 AND effective_year = $3", [tenantId, month, year]);
    return result.rows[0] ? toPoolDomain(result.rows[0]) : null;
  }

  /** Locks the pool row for the duration of the caller's transaction — the serialization point that makes concurrent allocate() calls for the same tenant+period safe from a race between "read the current sum" and "write the new allocation". MUST be called with a real transaction-bound PoolClient (see CreditBudgetService.allocate). */
  async findPoolForUpdate(client: PoolClient, tenantId: string, month: number, year: number): Promise<OrganizationCreditPool | null> {
    const result = await client.query<PoolRow>("SELECT * FROM organization_credit_pools WHERE tenant_id = $1 AND effective_month = $2 AND effective_year = $3 FOR UPDATE", [tenantId, month, year]);
    return result.rows[0] ? toPoolDomain(result.rows[0]) : null;
  }

  /** Sum of every OTHER team's allocation for this period — the denominator check for "does this new/updated allocation still fit within the pool". */
  async sumAllocatedForPeriod(client: Pool | PoolClient | undefined, tenantId: string, month: number, year: number, excludeTeamId?: string): Promise<number> {
    const executor = client ?? this.pool;
    const params: unknown[] = [tenantId, month, year];
    let query = "SELECT COALESCE(SUM(allocated_credits), 0) AS total FROM credit_budgets WHERE tenant_id = $1 AND effective_month = $2 AND effective_year = $3";
    if (excludeTeamId) {
      params.push(excludeTeamId);
      query += ` AND team_id != $${params.length}`;
    }
    const result = await executor.query<{ total: string }>(query, params);
    return Number(result.rows[0]?.total ?? 0);
  }

  async findBudget(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, month: number, year: number): Promise<CreditBudget | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<BudgetRow>("SELECT * FROM credit_budgets WHERE tenant_id = $1 AND team_id = $2 AND effective_month = $3 AND effective_year = $4", [tenantId, teamId, month, year]);
    return result.rows[0] ? toBudgetDomain(result.rows[0]) : null;
  }

  async findAllForPeriod(client: Pool | PoolClient | undefined, tenantId: string, month: number, year: number): Promise<CreditBudget[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<BudgetRow>("SELECT * FROM credit_budgets WHERE tenant_id = $1 AND effective_month = $2 AND effective_year = $3 ORDER BY team_id", [tenantId, month, year]);
    return result.rows.map(toBudgetDomain);
  }

  async upsertBudget(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, request: AllocateBudgetRequest): Promise<CreditBudget> {
    const executor = client ?? this.pool;
    const result = await executor.query<BudgetRow>(
      `INSERT INTO credit_budgets (tenant_id, team_id, allocated_credits, alert_threshold_75, alert_threshold_90, hard_cap, effective_month, effective_year, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, team_id, effective_month, effective_year) DO UPDATE
         SET allocated_credits = $3, alert_threshold_75 = $4, alert_threshold_90 = $5, hard_cap = $6, updated_at = now()
       RETURNING *`,
      [tenantId, request.teamId, request.allocatedCredits, request.alertThreshold75, request.alertThreshold90, request.hardCap, request.effectiveMonth, request.effectiveYear, actorId],
    );
    return toBudgetDomain(result.rows[0]);
  }

  /** Gross debits (consumption) for one team within [monthStart, monthEnd) — the budget-period-scoped usage figure, distinct from the ledger's lifetime running balance. */
  async getConsumedCreditsForPeriod(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, monthStart: Date, monthEnd: Date): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ total: string }>(
      "SELECT COALESCE(SUM(credits_debit), 0) AS total FROM credit_transactions WHERE tenant_id = $1 AND team_id = $2 AND occurred_at >= $3 AND occurred_at < $4",
      [tenantId, teamId, monthStart, monthEnd],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /** Average daily consumption over the trailing 30 days from `now` — the exhaustion-date projection's own denominator. */
  async getTrailing30DayDailyAverage(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, now: Date): Promise<number> {
    const executor = client ?? this.pool;
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const result = await executor.query<{ total: string }>("SELECT COALESCE(SUM(credits_debit), 0) AS total FROM credit_transactions WHERE tenant_id = $1 AND team_id = $2 AND occurred_at >= $3 AND occurred_at < $4", [
      tenantId,
      teamId,
      since,
      now,
    ]);
    return Number(result.rows[0]?.total ?? 0) / 30;
  }
}
