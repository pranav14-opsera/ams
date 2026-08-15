import { BadRequestException, Body, Controller, Get, Param, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { UpdateQualityScoreConfigDto } from "./dto/update-quality-score-config.dto";
import { QualityScoreService } from "./quality-score.service";

@Controller("api/v1")
export class QualityScoreController {
  constructor(private readonly service: QualityScoreService) {}

  // Read-level: same "closest existing read-level grant" precedent used across this observability epic — anyone who can see the agent can see its quality score.
  @Get("agents/:id/quality-score")
  @RequirePermission(PermissionName.AGENT_READ)
  async getQualityScore(@Param("id") agentId: string, @Req() req: Request) {
    return this.service.getAgentSummary(req.tenantDbClient, req.tenantId!, agentId);
  }

  @Get("agents/:id/quality-score/history")
  @RequirePermission(PermissionName.AGENT_READ)
  async getQualityScoreHistory(@Param("id") agentId: string, @Query("sinceDays") sinceDays: string | undefined, @Req() req: Request) {
    const days = sinceDays ? Number(sinceDays) : 7;
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.service.getScoreHistory(req.tenantDbClient, req.tenantId!, agentId, sinceIso);
  }

  // Mutation gated the same as alert threshold/anomaly-config management (ALERT_THRESHOLD_MANAGE) — the closest existing "admin-tunes-an-observability-knob" permission in this codebase; there is no dedicated quality-score permission and adding a brand-new one is out of this WO's scope.
  @Put("quality-score/config")
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async updateConfig(@Body() dto: UpdateQualityScoreConfigDto, @Req() req: Request) {
    if (dto.toolCallWeight + dto.reasoningWeight + dto.consistencyWeight !== 100) {
      throw new BadRequestException("toolCallWeight + reasoningWeight + consistencyWeight must sum to 100.");
    }
    return this.service.setWeights(req.tenantDbClient, req.tenantId!, dto.toolCallWeight, dto.reasoningWeight, dto.consistencyWeight);
  }
}
