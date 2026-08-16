import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { CreditBudgetRepository } from "./credit-budget.repository";
import type { AllocateBudgetRequest, CreditBudget, TeamBudgetSummary } from "./credit-budget.types";

function monthBounds(month: number, year: number): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  return { start, end };
}

/**
 * AC: "the sum of all team allocations does not exceed the organization's
 * total credit pool." Enforced transactionally — `allocate` acquires its
 * own connection, `SELECT ... FOR UPDATE`s the pool row for this
 * tenant+period (serializing concurrent allocation attempts for the same
 * period), sums every OTHER team's current allocation, and only commits
 * the new/updated allocation if it still fits.
 */
@Injectable()
export class CreditBudgetService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: CreditBudgetRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async allocate(tenantId: string, actorId: string | null, request: AllocateBudgetRequest): Promise<CreditBudget> {
    const scoped = await this.pool.connect();
    try {
      await scoped.query("BEGIN");

      const orgPool = await this.repository.findPoolForUpdate(scoped, tenantId, request.effectiveMonth, request.effectiveYear);
      if (!orgPool) {
        throw new BadRequestException(`No organization credit pool is configured for ${request.effectiveMonth}/${request.effectiveYear} — allocate the pool itself before allocating team budgets against it.`);
      }

      const previous = await this.repository.findBudget(scoped, tenantId, request.teamId, request.effectiveMonth, request.effectiveYear);
      const otherTeamsTotal = await this.repository.sumAllocatedForPeriod(scoped, tenantId, request.effectiveMonth, request.effectiveYear, request.teamId);

      if (otherTeamsTotal + request.allocatedCredits > orgPool.totalCredits) {
        throw new BadRequestException(
          `Allocation of ${request.allocatedCredits} credits to this team would bring the total allocated (${otherTeamsTotal + request.allocatedCredits}) above the organization's pool of ${orgPool.totalCredits} credits for ${request.effectiveMonth}/${request.effectiveYear}.`,
        );
      }

      const budget = await this.repository.upsertBudget(scoped, tenantId, actorId, request);
      await scoped.query("COMMIT");

      // Best-effort, outside the transaction — an audit-plumbing failure must never roll back an already-committed allocation.
      await this.auditService
        .recordEvent({
          tenantId,
          actorId,
          action: "credit_budget.allocated",
          resourceType: "credit_budget",
          resourceId: budget.id,
          details: {
            teamId: request.teamId,
            previousAllocation: previous?.allocatedCredits ?? null,
            newAllocation: request.allocatedCredits,
            justification: request.justification,
          },
          dataClassification: DataClassification.CONFIDENTIAL,
        })
        .catch(() => undefined);

      return budget;
    } catch (err) {
      await scoped.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      scoped.release();
    }
  }

  async getTeamBudget(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, month: number, year: number, now: Date = new Date()): Promise<TeamBudgetSummary> {
    const budget = await this.repository.findBudget(client, tenantId, teamId, month, year);
    if (!budget) throw new NotFoundException(`No budget allocation exists for team ${teamId} in ${month}/${year}.`);
    return this.toSummary(client, budget, now);
  }

  async listBudgets(client: Pool | PoolClient | undefined, tenantId: string, month: number, year: number, now: Date = new Date()): Promise<TeamBudgetSummary[]> {
    const budgets = await this.repository.findAllForPeriod(client, tenantId, month, year);
    return Promise.all(budgets.map((budget) => this.toSummary(client, budget, now)));
  }

  private async toSummary(client: Pool | PoolClient | undefined, budget: CreditBudget, now: Date): Promise<TeamBudgetSummary> {
    const { start, end } = monthBounds(budget.effectiveMonth, budget.effectiveYear);
    const periodEnd = end < now ? end : now;
    const consumedCredits = await this.repository.getConsumedCreditsForPeriod(client, budget.tenantId, budget.teamId, start, periodEnd);
    const remainingCredits = budget.allocatedCredits - consumedCredits;
    const consumptionPercentage = budget.allocatedCredits > 0 ? Math.round((consumedCredits / budget.allocatedCredits) * 1000) / 10 : null;

    const dailyAverage = await this.repository.getTrailing30DayDailyAverage(client, budget.tenantId, budget.teamId, now);
    const projectedExhaustionDate = dailyAverage > 0 && remainingCredits > 0 ? new Date(now.getTime() + (remainingCredits / dailyAverage) * 24 * 60 * 60 * 1000).toISOString() : null;

    return {
      teamId: budget.teamId,
      allocatedCredits: budget.allocatedCredits,
      consumedCredits,
      remainingCredits,
      consumptionPercentage,
      alertThreshold75: budget.alertThreshold75,
      alertThreshold90: budget.alertThreshold90,
      hardCap: budget.hardCap,
      effectiveMonth: budget.effectiveMonth,
      effectiveYear: budget.effectiveYear,
      projectedExhaustionDate,
    };
  }
}
