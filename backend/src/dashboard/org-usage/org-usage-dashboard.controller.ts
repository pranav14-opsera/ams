import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequireAnyPermission } from "../../rbac/require-any-permission.decorator";
import { UsagePeriodQueryDto } from "./dto/usage-period-query.dto";
import { OrgUsageDashboardService } from "./org-usage-dashboard.service";

/**
 * AC: "accessible only to users with Platform Administrator or Team Lead
 * roles; unauthorized roles receive HTTP 403." Gated via
 * RequireAnyPermission — see migration 058's own comment for why
 * platform_admin needed a new grant (credit_management:consumption:
 * view_org) to satisfy this literally, and why team_lead's existing
 * view_team permission is reused for this ORG-scoped route (same "reuse
 * an existing permission for a broader route than its name implies"
 * move DashboardController/WO-056 already documents for AGENT_READ).
 * RbacGuard denies (403) any caller holding neither permission —
 * finance_manager (view_org only) and agent_operator/compliance_officer
 * (neither) are all denied here, exactly matching the AC's literal role
 * list.
 */
@Controller("api/v1/dashboards/usage")
export class OrgUsageDashboardController {
  constructor(private readonly service: OrgUsageDashboardService) {}

  @Get("org")
  @RequireAnyPermission([PermissionName.CREDIT_CONSUMPTION_VIEW_ORG, PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM])
  async getOrgUsage(@Query() query: UsagePeriodQueryDto, @Req() req: Request) {
    return this.service.getOrgUsageSummary(req.tenantDbClient, { tenantId: req.tenantId!, actorId: req.actorId ?? null }, query.period, query.granularity);
  }
}
