import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { QualityScoreService } from "../quality-score/quality-score.service";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { DriftEventRepository } from "./drift-event.repository";
import { DriftStateRepository } from "./drift-state.repository";

@Controller("api/v1/agents")
export class DriftDetectionController {
  constructor(
    private readonly driftEventRepository: DriftEventRepository,
    private readonly driftStateRepository: DriftStateRepository,
    private readonly qualityScoreService: QualityScoreService,
  ) {}

  // Read-level: same "closest existing read-level grant" precedent used across this entire observability epic.
  @Get(":id/drift")
  @RequirePermission(PermissionName.AGENT_READ)
  async getDriftStatus(@Param("id") agentId: string, @Query("sinceDays") sinceDays: string | undefined, @Req() req: Request) {
    const days = sinceDays ? Number(sinceDays) : 7;
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [state, history] = await Promise.all([
      this.driftStateRepository.find(req.tenantDbClient, req.tenantId!, agentId),
      this.driftEventRepository.findHistory(req.tenantDbClient, req.tenantId!, agentId, sinceIso),
    ]);

    return {
      agentId,
      consecutiveDriftCount: state?.consecutiveDriftCount ?? 0,
      lastEvaluatedAt: state?.lastEvaluatedAt ? state.lastEvaluatedAt.toISOString() : null,
      lastKsStatistic: state?.lastKsStatistic ?? null,
      lastPValue: state?.lastPValue ?? null,
      history,
    };
  }

  // Mutation gated the same as the other observability-admin knobs (ALERT_THRESHOLD_MANAGE) — no dedicated drift-detection permission exists, and adding one is out of this WO's scope.
  @Post(":id/drift/reset-baseline")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async resetBaseline(@Param("id") agentId: string, @Req() req: Request) {
    await this.qualityScoreService.resetCalibration(req.tenantDbClient, req.tenantId!, agentId);
  }
}
