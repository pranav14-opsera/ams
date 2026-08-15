import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { DashboardService } from "./dashboard.service";
import { ListAgentHealthQueryDto } from "./dto/list-agent-health-query.dto";

@Controller("api/v1/agents")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // No dedicated "health dashboard" permission exists in the RBAC matrix
  // yet — reuses agent_management:agent:read, the same grant
  // NAVIGATION_CONFIG's health-dashboard nav entry already reuses
  // (frontend/src/config/navigation.ts), so a caller who can see the nav
  // item can also load its data.
  @Get("health")
  @RequirePermission(PermissionName.AGENT_READ)
  async getFleetHealth(@Query() query: ListAgentHealthQueryDto, @Req() req: Request) {
    return this.dashboardService.getFleetHealth(req.tenantDbClient, { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] }, query);
  }
}
