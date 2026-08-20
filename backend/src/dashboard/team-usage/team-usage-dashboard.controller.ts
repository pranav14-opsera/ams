import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequireAnyPermission } from "../../rbac/require-any-permission.decorator";
import { TeamUsageQueryDto } from "./dto/team-usage-query.dto";
import { TeamUsageDashboardService } from "./team-usage-dashboard.service";

/**
 * AC 1: "accessible to Team Lead (own team only) and Platform
 * Administrator (all teams with team selector)". Gated the same way
 * OrgUsageDashboardController is (RequireAnyPermission of the org/team
 * consumption-view grants) — team_id here is a QUERY param (per this
 * WO's own literal api_contracts), not a route param, so RbacGuard's
 * generic @ResourceTeamParam mechanism (which only ever reads
 * req.params) can't enforce the cross-team check for this route the way
 * it does for CreditBudgetController's `/budgets/:teamId`.
 * TeamUsageDashboardService.resolveTeamId is this route's own equivalent
 * check, applied to the query param instead of a route param — same
 * "org-scoped roles pass for any team, team-scoped roles only pass for
 * their own" outcome, just enforced one layer up.
 */
@Controller("api/v1/dashboards/usage")
export class TeamUsageDashboardController {
  constructor(private readonly service: TeamUsageDashboardService) {}

  @Get("team")
  @RequireAnyPermission([PermissionName.CREDIT_CONSUMPTION_VIEW_ORG, PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM])
  async getTeamUsage(@Query() query: TeamUsageQueryDto, @Req() req: Request) {
    const ctx = { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] };
    const teamId = await this.service.resolveTeamId(req.tenantDbClient, ctx, query.team_id);
    return this.service.getTeamUsageSummary(req.tenantDbClient, ctx, teamId, query.period, query.granularity, {
      agentIds: query.agents,
      actionTypes: query.action_types,
      frameworks: query.frameworks,
    });
  }

  // Not in this WO's own literal api_contracts, but required to actually
  // populate AC 6's team selector (Platform Administrator: every team in
  // the tenant; Team Lead: only the team(s) they belong to, per
  // edge_cases' "Team Lead in multiple teams sees only their teams in
  // selector") — the frontend has no other endpoint to source that list
  // from.
  @Get("team/teams")
  @RequireAnyPermission([PermissionName.CREDIT_CONSUMPTION_VIEW_ORG, PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM])
  async listTeams(@Req() req: Request) {
    const ctx = { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] };
    const teams = await this.service.listSelectableTeams(req.tenantDbClient, ctx);
    return { teams };
  }
}
