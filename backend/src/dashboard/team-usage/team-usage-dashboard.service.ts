import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../../classification/data-classification.enum";
import { CreditBudgetService } from "../../credits/budget/credit-budget.service";
import { PlatformRoleName } from "../../rbac/rbac.constants";
import { TeamMembershipRepository } from "../../rbac/team-membership.repository";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { TeamUsageCacheService } from "./team-usage-cache.service";
import { TeamUsageDashboardRepository, type TeamUsageRepositoryFilters } from "./team-usage-dashboard.repository";
import {
  dbFrameworkToTeamUsageWire,
  teamPeriodToDays,
  teamUsageFrameworksToDb,
  type TeamAgentComparisonEntry,
  type TeamBalanceSummary,
  type TeamConsumptionTrendPoint,
  type TeamRef,
  type TeamUsageFilters,
  type TeamUsageGranularity,
  type TeamUsagePeriod,
  type TeamUsageSummary,
} from "./team-usage-dashboard.types";

export interface TeamUsageActorContext {
  tenantId: string;
  actorId: string | null;
  roles: string[];
}

// Same TEAM_SCOPED_ROLES list as RbacGuard's own (rbac.guard.ts) and
// AgentHealthDetailService's own — team_lead/agent_operator are the two
// roles this platform ever restricts to "their own team only"; every
// other role (platform_admin, finance_manager, compliance_officer) is
// org-scoped for this dashboard's purposes.
const TEAM_SCOPED_ROLES: readonly string[] = [PlatformRoleName.TEAM_LEAD, PlatformRoleName.AGENT_OPERATOR];

const BURN_RATE_WINDOW_DAYS = 7; // matches OrgUsageDashboardService's own smoothing window (same rationale: a single noisy day shouldn't swing the reported rate).
const ABOVE_THRESHOLD_MULTIPLIER = 2; // AC 4: "visual indicators for agents exceeding team average by more than 2x."

function toRepositoryFilters(filters: TeamUsageFilters): TeamUsageRepositoryFilters {
  return {
    agentIds: filters.agentIds,
    actionTypes: filters.actionTypes,
    frameworks: filters.frameworks ? teamUsageFrameworksToDb(filters.frameworks) : undefined,
  };
}

/** Stable cache key for a given filter combination — order-independent (sorted) so equivalent query-param orderings hit the same cache entry. */
function filterHash(period: TeamUsagePeriod, granularity: TeamUsageGranularity, filters: TeamUsageFilters): string {
  return JSON.stringify({
    period,
    granularity,
    agents: [...(filters.agentIds ?? [])].sort(),
    actionTypes: [...(filters.actionTypes ?? [])].sort(),
    frameworks: [...(filters.frameworks ?? [])].sort(),
  });
}

/**
 * AC: team-scoped usage analytics — reuses OrgUsageDashboardService's own
 * shape (balance/burn-rate KPIs, cache-fallback-on-live-query-failure)
 * but adds team resolution/authorization (AC 1/5/6) and the richer
 * filter set (AC 3/4/7) this WO's own dashboard needs.
 */
@Injectable()
export class TeamUsageDashboardService {
  private readonly logger = new Logger(TeamUsageDashboardService.name);

  constructor(
    private readonly repository: TeamUsageDashboardRepository,
    private readonly cache: TeamUsageCacheService,
    private readonly creditBudgetService: CreditBudgetService,
    private readonly teamMembershipRepository: TeamMembershipRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  /**
   * AC 1/5/6: resolves which team a request targets, and denies
   * cross-team access outright. A Platform Administrator (or any other
   * org-scoped role holding the route's own view_org/view_team
   * permission) may target ANY team, defaulting to the tenant's first
   * team (by name) when team_id is omitted, per this WO's own
   * api_contracts ("optional for Admin defaulting to first team"). A
   * team-scoped caller (Team Lead/Agent Operator) MUST supply a team_id
   * they actually belong to — never silently substituted with whichever
   * team they happen to belong to, since that would make the query
   * param meaningless and could mask a client bug that dropped it.
   */
  async resolveTeamId(client: Pool | PoolClient | undefined, ctx: TeamUsageActorContext, requestedTeamId: string | undefined): Promise<string> {
    const isTeamScopedCaller = ctx.roles.some((role) => TEAM_SCOPED_ROLES.includes(role));

    if (!isTeamScopedCaller) {
      if (requestedTeamId) return requestedTeamId;
      const teams = await this.repository.listTeamsForTenant(client, ctx.tenantId);
      // edge_case: "Admin with no teams shows guidance empty state" — the
      // controller/frontend renders this NotFoundException as that
      // empty state rather than a raw 404 error page.
      if (teams.length === 0) throw new NotFoundException("This tenant has no teams configured yet.");
      return teams[0].id;
    }

    if (!requestedTeamId) throw new BadRequestException("team_id is required.");
    if (!ctx.actorId) throw new ForbiddenException("You do not have access to this team.");

    const userTeamIds = await this.teamMembershipRepository.getUserTeamIds(ctx.tenantId, ctx.actorId, client);
    if (!userTeamIds.includes(requestedTeamId)) {
      // AC 5/CONSTRAINTS: "Team Leads must never see other teams' data
      // even same tenant" — denied here before any query touches this
      // team's consumption data at all.
      throw new ForbiddenException("You do not have access to this team.");
    }
    return requestedTeamId;
  }

  /** AC 6/edge_cases: the team selector's own options — every team in the tenant for an org-scoped caller, only the caller's own teams otherwise. */
  async listSelectableTeams(client: Pool | PoolClient | undefined, ctx: TeamUsageActorContext): Promise<TeamRef[]> {
    const isTeamScopedCaller = ctx.roles.some((role) => TEAM_SCOPED_ROLES.includes(role));
    if (!isTeamScopedCaller) return this.repository.listTeamsForTenant(client, ctx.tenantId);
    if (!ctx.actorId) return [];
    return this.repository.listTeamsForUser(client, ctx.tenantId, ctx.actorId);
  }

  private async computeBalance(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, now: Date): Promise<TeamBalanceSummary> {
    // Reuses CreditBudgetService's own team-budget computation (WO-068)
    // rather than re-deriving allocated/consumed/remaining independently
    // — one canonical "team balance" calculation, not two that could
    // drift apart. A team with no budget row for the current month
    // (edge case: never-allocated team) throws NotFoundException there;
    // treated here as an honestly-zero, un-budgeted balance rather than
    // letting that 404 bubble up and break the whole dashboard.
    try {
      const summary = await this.creditBudgetService.getTeamBudget(client, tenantId, teamId, now.getUTCMonth() + 1, now.getUTCFullYear());
      return {
        allocated: summary.allocatedCredits,
        consumed: summary.consumedCredits,
        remaining: summary.remainingCredits < 0 ? 0 : summary.remainingCredits,
        utilizationPct: summary.consumptionPercentage,
      };
    } catch (err) {
      if (err instanceof NotFoundException) {
        const consumed = await this.repository.getRecentTeamConsumptionTotal(client, tenantId, teamId, 30);
        return { allocated: 0, consumed, remaining: 0, utilizationPct: null };
      }
      throw err;
    }
  }

  /** Backs `GET /api/v1/dashboards/usage/team`. Falls back to the last-known-good cached snapshot on any live-query failure (same error_handling posture as OrgUsageDashboardService). */
  async getTeamUsageSummary(
    client: Pool | PoolClient | undefined,
    ctx: TeamUsageActorContext,
    teamId: string,
    period: TeamUsagePeriod = "30d",
    granularity: TeamUsageGranularity = "daily",
    filters: TeamUsageFilters = {},
    now: Date = new Date(),
  ): Promise<TeamUsageSummary> {
    const team = await this.repository.getTeam(client, ctx.tenantId, teamId);
    if (!team) throw new NotFoundException(`Team ${teamId} not found.`);

    const days = teamPeriodToDays(period);
    const hash = filterHash(period, granularity, filters);

    try {
      const agentCount = await this.repository.getTeamAgentCount(client, ctx.tenantId, teamId);
      const balance = await this.computeBalance(client, ctx.tenantId, teamId, now);
      const recentTotal = await this.repository.getRecentTeamConsumptionTotal(client, ctx.tenantId, teamId, BURN_RATE_WINDOW_DAYS);
      const burnRate = { creditsPerDay: recentTotal / BURN_RATE_WINDOW_DAYS };

      const repositoryFilters = toRepositoryFilters(filters);
      const rows = await this.repository.getTeamConsumptionRows(client, ctx.tenantId, teamId, days, granularity, repositoryFilters);
      const roster = await this.repository.getTeamAgentRoster(client, ctx.tenantId, teamId, repositoryFilters.frameworks);

      const consumptionTrend = this.buildTrend(rows);
      const agentComparison = this.buildAgentComparison(rows, roster, repositoryFilters.agentIds);

      const result: TeamUsageSummary = {
        team,
        balance,
        burnRate,
        agentCount,
        consumptionTrend,
        agentComparison,
        filtersApplied: { period, granularity, agents: filters.agentIds, actionTypes: filters.actionTypes, frameworks: filters.frameworks },
        servedFromCache: false,
      };
      await this.cache.setSnapshot(ctx.tenantId, teamId, hash, result);
      this.recordDashboardViewAuditEvent(ctx, teamId, filters);
      return result;
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof BadRequestException || err instanceof ForbiddenException) throw err;

      this.logger.warn(`live team usage query failed for tenant ${ctx.tenantId} team ${teamId}, falling back to cached snapshot: ${err instanceof Error ? err.message : err}`);
      const cached = (await this.cache.getSnapshot(ctx.tenantId, teamId, hash)) as TeamUsageSummary | null;
      if (!cached) throw err;
      this.recordDashboardViewAuditEvent(ctx, teamId, filters);
      return { ...cached, servedFromCache: true };
    }
  }

  /** Sums every agent's credits per bucket into one team-wide trend point (AC 3's trend chart is team-wide, not per-agent). */
  private buildTrend(rows: Array<{ bucket: Date; credits: string }>): TeamConsumptionTrendPoint[] {
    const byBucket = new Map<string, number>();
    for (const row of rows) {
      const key = row.bucket.toISOString();
      byBucket.set(key, (byBucket.get(key) ?? 0) + Number(row.credits));
    }
    return [...byBucket.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, credits]) => ({ date, credits }));
  }

  /**
   * AC 4: sums each agent's credits across every bucket, then flags any
   * agent whose total exceeds 2x the mean across the comparison set.
   * Every agent on the team's roster appears here, even one with zero
   * matching rows under the current filter (edge_cases: "agent
   * reassigned mid-period keeps historical attribution" — a roster
   * agent excluded from `rows` entirely, e.g. by an action_type filter
   * that never matched it, still surfaces as a real zero, not a gap).
   */
  private buildAgentComparison(
    rows: Array<{ agent_id: string; agent_name: string; framework: string; credits: string }>,
    roster: Array<{ id: string; name: string; framework: string }>,
    agentIdFilter: string[] | undefined,
  ): TeamAgentComparisonEntry[] {
    const totals = new Map<string, number>();
    const meta = new Map<string, { name: string; framework: string }>();

    for (const agent of roster) {
      if (agentIdFilter && !agentIdFilter.includes(agent.id)) continue;
      totals.set(agent.id, 0);
      meta.set(agent.id, { name: agent.name, framework: agent.framework });
    }
    for (const row of rows) {
      if (agentIdFilter && !agentIdFilter.includes(row.agent_id)) continue;
      totals.set(row.agent_id, (totals.get(row.agent_id) ?? 0) + Number(row.credits));
      if (!meta.has(row.agent_id)) meta.set(row.agent_id, { name: row.agent_name, framework: row.framework });
    }

    const entries = [...totals.entries()];
    const mean = entries.length > 0 ? entries.reduce((sum, [, v]) => sum + v, 0) / entries.length : 0;

    return entries
      .map(([agentId, creditsConsumed]) => {
        const info = meta.get(agentId)!;
        return {
          agentId,
          agentName: info.name,
          framework: dbFrameworkToTeamUsageWire(info.framework),
          creditsConsumed,
          isAboveThreshold: mean > 0 && creditsConsumed > mean * ABOVE_THRESHOLD_MULTIPLIER,
        };
      })
      .sort((a, b) => b.creditsConsumed - a.creditsConsumed);
  }

  private recordDashboardViewAuditEvent(ctx: TeamUsageActorContext, teamId: string, filters: TeamUsageFilters): void {
    // AC 10 (audit logging): "team_id, applied filters, actor context" —
    // best-effort, same never-fail-the-dashboard-over-audit-plumbing
    // posture as OrgUsageDashboardService.recordDashboardViewAuditEvent.
    this.auditService
      .recordEvent({
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: "dashboard.team_usage_viewed",
        resourceType: "team_usage_dashboard",
        resourceId: teamId,
        details: { view: "team_usage", teamId, filters },
        dataClassification: DataClassification.INTERNAL,
      })
      .catch((err) => this.logger.warn(`failed to record team usage dashboard view audit event: ${err instanceof Error ? err.message : err}`));
  }
}
