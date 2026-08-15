import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequireAnyPermission } from "../rbac/require-any-permission.decorator";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AgentHealthDetailService } from "./agent-health-detail.service";
import { AgentHealthHistoryQueryDto } from "./dto/agent-health-history-query.dto";
import { AgentTracesQueryDto } from "./dto/agent-traces-query.dto";

@Controller("api/v1/agents/:id")
export class AgentHealthDetailController {
  constructor(private readonly service: AgentHealthDetailService) {}

  @Get("health/history")
  @RequirePermission(PermissionName.AGENT_READ)
  async getHealthHistory(@Param("id") id: string, @Query() query: AgentHealthHistoryQueryDto, @Req() req: Request) {
    return this.service.getHealthHistory(req.tenantDbClient, { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] }, id, query.range ?? "24h");
  }

  // Either trace permission grants access — platform_admin/team_lead hold
  // trace:view_all, agent_operator holds trace:view_assigned only (per
  // rbac.constants.ts's seed matrix). WHICH agents a caller may query is
  // then enforced by assertAgentAccessible's team/tenant scoping, not by
  // which of the two trace permissions they hold.
  @Get("traces")
  @RequireAnyPermission([PermissionName.TRACE_VIEW_ALL, PermissionName.TRACE_VIEW_ASSIGNED])
  async getTraces(@Param("id") id: string, @Query() query: AgentTracesQueryDto, @Req() req: Request) {
    return this.service.getTraces(req.tenantDbClient, { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] }, id, {
      status: query.status,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
  }

  @Get("lifecycle-history")
  @RequirePermission(PermissionName.AGENT_READ)
  async getLifecycleHistory(@Param("id") id: string, @Req() req: Request) {
    return this.service.getLifecycleHistory(req.tenantDbClient, { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] }, id);
  }
}
