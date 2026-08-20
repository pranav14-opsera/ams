import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequireAnyPermission } from "../../rbac/require-any-permission.decorator";
import { ConsumptionQueryDto } from "./dto/consumption-query.dto";
import type { UsageGranularity } from "./org-usage-dashboard.types";
import { OrgUsageDashboardService } from "./org-usage-dashboard.service";

function daysBetween(startDate: string | undefined, endDate: string | undefined): number {
  if (!startDate) return 30; // AC default window when no date_range is supplied.
  const start = new Date(startDate).getTime();
  const end = endDate ? new Date(endDate).getTime() : Date.now();
  const days = Math.ceil((end - start) / (24 * 60 * 60 * 1000));
  return days < 1 ? 1 : days;
}

/** Same org/team access rule as OrgUsageDashboardController — see its own comment and migration 058 for the RBAC gap this closes. */
@Controller("api/v1/credits")
export class OrgUsageCreditsController {
  constructor(private readonly service: OrgUsageDashboardService) {}

  @Get("balance")
  @RequireAnyPermission([PermissionName.CREDIT_CONSUMPTION_VIEW_ORG, PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM])
  async getBalance(@Req() req: Request) {
    return this.service.getBalance(req.tenantDbClient, req.tenantId!);
  }

  @Get("consumption")
  @RequireAnyPermission([PermissionName.CREDIT_CONSUMPTION_VIEW_ORG, PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM])
  async getConsumption(@Query() query: ConsumptionQueryDto, @Req() req: Request) {
    const days = daysBetween(query.startDate, query.endDate);
    const granularity: UsageGranularity = query.granularity ?? "daily";
    const result = await this.service.getConsumption(req.tenantDbClient, req.tenantId!, days, granularity, query.groupBy);

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return {
      trend: result.trend,
      agentBreakdown: result.agentBreakdown.slice(offset, offset + limit),
      total: result.agentBreakdown.length,
      limit,
      offset,
    };
  }
}
