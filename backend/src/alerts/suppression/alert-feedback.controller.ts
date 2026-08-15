import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequirePermission } from "../../rbac/require-permission.decorator";
import { AlertFeedbackService } from "./alert-feedback.service";
import { AlertSuppressionService } from "./alert-suppression.service";
import { CreateSnoozeDto } from "./dto/create-snooze.dto";
import { SubmitFeedbackDto } from "./dto/submit-feedback.dto";

@Controller("api/v1/alerts")
export class AlertFeedbackController {
  constructor(
    private readonly feedbackService: AlertFeedbackService,
    private readonly suppressionService: AlertSuppressionService,
  ) {}

  // Read-level: any caller who can see the alert at all can confirm/dismiss it — same "closest existing read-level grant" precedent as WO-059's own threshold-read endpoint.
  @Post(":alertEventId/feedback")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.AGENT_READ)
  async submitFeedback(@Param("alertEventId") alertEventId: string, @Body() dto: SubmitFeedbackDto, @Req() req: Request) {
    return this.feedbackService.submitFeedback(req.tenantDbClient, req.tenantId!, req.actorId ?? null, alertEventId, dto.feedbackType);
  }

  @Post("snooze")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async createSnooze(@Body() dto: CreateSnoozeDto, @Req() req: Request) {
    return this.suppressionService.createSnooze(req.tenantDbClient, req.tenantId!, req.actorId ?? null, dto.agentId, dto.metricName, dto.duration);
  }

  @Delete("snooze/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async removeSnooze(@Param("id") id: string, @Req() req: Request) {
    await this.suppressionService.removeSnooze(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id);
  }

  @Get("suppression/metrics")
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async getSuppressionMetrics(@Req() req: Request) {
    return this.suppressionService.getSuppressionMetrics(req.tenantDbClient, req.tenantId!);
  }
}
