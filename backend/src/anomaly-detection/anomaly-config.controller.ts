import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AnomalyBaselineRepository } from "./anomaly-baseline.repository";
import { CalibrationService } from "./calibration.service";
import { ConfigureAnomalyDetectionDto } from "./dto/configure-anomaly-detection.dto";
import { DriftDetectionConfigRepository } from "./drift-detection-config.repository";

@Controller("api/v1/agents/:id/anomaly-config")
export class AnomalyConfigController {
  constructor(
    private readonly driftConfigRepository: DriftDetectionConfigRepository,
    private readonly baselineRepository: AnomalyBaselineRepository,
    private readonly calibrationService: CalibrationService,
  ) {}

  // Admin-only, same permission WO-059's own threshold-config CRUD uses — sensitivity is a comparably security/noise-sensitive configuration surface.
  @Post()
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async configure(@Param("id") agentId: string, @Body() dto: ConfigureAnomalyDetectionDto, @Req() req: Request) {
    const config = await this.driftConfigRepository.upsert(req.tenantDbClient, req.tenantId!, agentId, dto.sensitivity, dto.enabled ?? true);
    await this.calibrationService.startCalibration(req.tenantDbClient, req.tenantId!, agentId);
    return config;
  }

  @Get()
  @RequirePermission(PermissionName.AGENT_READ)
  async getStatus(@Param("id") agentId: string, @Req() req: Request) {
    const config = await this.driftConfigRepository.findByAgentId(req.tenantDbClient, req.tenantId!, agentId);
    const baselines = await this.baselineRepository.findAllByAgent(req.tenantDbClient, req.tenantId!, agentId);

    return {
      config,
      baselines: baselines.map((baseline) => ({
        ...baseline,
        calibrationStatus: this.calibrationService.getCalibrationStatus(baseline.calibrationStartedAt, baseline.calibrationCompletedAt),
      })),
    };
  }
}
