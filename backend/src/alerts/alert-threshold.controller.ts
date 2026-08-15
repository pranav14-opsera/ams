import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AlertThresholdService } from "./alert-threshold.service";
import { CreateAlertThresholdDto } from "./dto/create-alert-threshold.dto";
import { UpdateAlertThresholdDto } from "./dto/update-alert-threshold.dto";

@Controller("api/v1/alerts/thresholds")
export class AlertThresholdController {
  constructor(private readonly service: AlertThresholdService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async create(@Body() dto: CreateAlertThresholdDto, @Req() req: Request) {
    return this.service.create(req.tenantDbClient, req.tenantId!, req.actorId ?? null, dto);
  }

  // Read access reuses agent_management:agent:read (same "closest
  // existing read-level grant" precedent as WO-056's health-dashboard
  // endpoint) — every role that can see an agent at all can see its
  // threshold configuration; only mutation is admin-gated.
  @Get()
  @RequirePermission(PermissionName.AGENT_READ)
  async findByAgent(@Query("agentId") agentId: string, @Req() req: Request) {
    return this.service.findByAgentId(req.tenantDbClient, req.tenantId!, agentId);
  }

  @Patch(":id")
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async update(@Param("id") id: string, @Body() dto: UpdateAlertThresholdDto, @Req() req: Request) {
    return this.service.update(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async remove(@Param("id") id: string, @Req() req: Request) {
    await this.service.delete(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id);
  }
}
