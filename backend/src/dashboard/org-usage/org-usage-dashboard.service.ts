import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { OrgUsageCacheService } from "./org-usage-cache.service";
import { OrgUsageDashboardRepository } from "./org-usage-dashboard.repository";
import {
  type AgentConsumptionEntry,
  type BurnRateSummary,
  type ConsumptionGroupBy,
  type ConsumptionTrendPoint,
  type CreditBalanceSummary,
  type OrgUsageSummary,
  periodToDays,
  type UsageGranularity,
  type UsagePeriod,
} from "./org-usage-dashboard.types";

export interface OrgUsageActorContext {
  tenantId: string;
  actorId: string | null;
}

// AC: burn rate averaged over a trailing window rather than a single
// day (a single day is noisy — one large batch job would make
// "projected exhaustion" swing wildly); 7 days matches this codebase's
// other rate-smoothing windows (e.g. WO-069's threshold-alert burn-rate
// calculation).
const BURN_RATE_WINDOW_DAYS = 7;

@Injectable()
export class OrgUsageDashboardService {
  private readonly logger = new Logger(OrgUsageDashboardService.name);

  constructor(
    private readonly repository: OrgUsageDashboardRepository,
    private readonly cache: OrgUsageCacheService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  private async computeBalance(client: Pool | PoolClient | undefined, tenantId: string): Promise<CreditBalanceSummary> {
    const { totalCredits, totalDebits } = await this.repository.getOrgBalanceTotals(client, tenantId);
    const remaining = totalCredits - totalDebits;
    return { total: totalCredits, consumed: totalDebits, remaining: remaining < 0 ? 0 : remaining };
  }

  private async computeBurnRate(client: Pool | PoolClient | undefined, tenantId: string, balance: CreditBalanceSummary): Promise<BurnRateSummary> {
    const recentTotal = await this.repository.getRecentConsumptionTotal(client, tenantId, BURN_RATE_WINDOW_DAYS);
    const creditsPerDay = recentTotal / BURN_RATE_WINDOW_DAYS;

    // edge_cases: "tenant at exactly 100% of credit cap — balance shows
    // zero, burn rate shows last known rate, projected exhaustion shows
    // 'Budget exhausted'" — modeled here as `null` (the API contract has
    // no dedicated "exhausted" sentinel string; the frontend renders
    // null + remaining === 0 as "Budget exhausted", see OrgUsageKPICards).
    if (balance.remaining <= 0) {
      return { creditsPerDay, projectedExhaustionDate: null };
    }
    if (creditsPerDay <= 0) {
      // Zero consumption (new tenant, or genuinely idle) — never exhausts at the current rate.
      return { creditsPerDay: 0, projectedExhaustionDate: null };
    }

    const daysRemaining = balance.remaining / creditsPerDay;
    const exhaustionDate = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000);
    return { creditsPerDay, projectedExhaustionDate: exhaustionDate.toISOString().slice(0, 10) };
  }

  /** Backs `GET /api/v1/dashboards/usage/org`. Falls back to the last-known-good cached snapshot on any live-query failure (error_handling AC). */
  async getOrgUsageSummary(
    client: Pool | PoolClient | undefined,
    ctx: OrgUsageActorContext,
    period: UsagePeriod = "30d",
    granularity: UsageGranularity = "daily",
  ): Promise<OrgUsageSummary> {
    const days = periodToDays(period);

    try {
      // Sequential, not Promise.all: `client` may be a single PoolClient
      // bound to one request-scoped transaction (this codebase's own
      // convention — see req.tenantDbClient in every controller here) —
      // a single pg connection can only run ONE query at a time, so
      // firing these concurrently on the same client either throws or
      // (worse) silently interleaves results. A bare `Pool` would tolerate
      // concurrency fine, but this must be safe for both call shapes.
      const balance = await this.computeBalance(client, ctx.tenantId);
      const burnRate = await this.computeBurnRate(client, ctx.tenantId, balance);
      const activeAgents = await this.repository.getActiveAgentCount(client, ctx.tenantId);
      const consumptionTrend = await this.repository.getConsumptionTrend(client, ctx.tenantId, days, granularity);
      const agentBreakdown = await this.repository.getAgentBreakdown(client, ctx.tenantId, days);

      const result: OrgUsageSummary = { balance, burnRate, activeAgents, consumptionTrend, agentBreakdown, servedFromCache: false };
      await this.cache.setSnapshot(ctx.tenantId, result);
      this.recordDashboardViewAuditEvent(ctx);
      return result;
    } catch (err) {
      this.logger.warn(`live org usage query failed for tenant ${ctx.tenantId}, falling back to cached snapshot: ${err instanceof Error ? err.message : err}`);
      const cached = (await this.cache.getSnapshot(ctx.tenantId)) as OrgUsageSummary | null;
      if (!cached) throw err;
      this.recordDashboardViewAuditEvent(ctx);
      return { ...cached, servedFromCache: true };
    }
  }

  /** Backs `GET /api/v1/credits/consumption` — trend when groupBy is omitted, agent breakdown when groupBy is "agent". Team/framework grouping of the agent breakdown is a light client-side reshape of the same per-agent rows (no separate query needed — the row count per tenant is small enough that this isn't a scaling concern). */
  async getConsumption(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    days: number,
    granularity: UsageGranularity,
    groupBy: ConsumptionGroupBy | undefined,
  ): Promise<{ trend: ConsumptionTrendPoint[]; agentBreakdown: AgentConsumptionEntry[] }> {
    // Sequential — same single-connection-safety reasoning as getOrgUsageSummary above.
    const trend = await this.repository.getConsumptionTrend(client, tenantId, days, granularity);
    const agentBreakdown = groupBy ? await this.repository.getAgentBreakdown(client, tenantId, days) : [];
    return { trend, agentBreakdown };
  }

  /** Backs `GET /api/v1/credits/balance` — Redis-cached read with PostgreSQL fallthrough (technical_details AC), independent of the fuller dashboard snapshot cache above. */
  async getBalance(client: Pool | PoolClient | undefined, tenantId: string): Promise<CreditBalanceSummary> {
    const cached = (await this.cache.getBalance(tenantId)) as CreditBalanceSummary | null;
    if (cached) return cached;

    const balance = await this.computeBalance(client, tenantId);
    await this.cache.setBalance(tenantId, balance);
    return balance;
  }

  private recordDashboardViewAuditEvent(ctx: OrgUsageActorContext): void {
    // AC: "an immutable audit log entry is created when a user views the
    // organization dashboard, including actor, tenant_id, timestamp, and
    // action type" — best-effort (never fails the dashboard response
    // over an audit-plumbing failure), same posture as every other
    // audited read path in this codebase (DashboardService's own
    // recordAccessAuditEvent).
    this.auditService
      .recordEvent({
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: "dashboard.org_usage_viewed",
        resourceType: "org_usage_dashboard",
        resourceId: ctx.tenantId,
        details: { view: "org_usage" },
        dataClassification: DataClassification.INTERNAL,
      })
      .catch((err) => this.logger.warn(`failed to record org usage dashboard view audit event: ${err instanceof Error ? err.message : err}`));
  }
}
