import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequireAnyPermission } from "../../rbac/require-any-permission.decorator";
import { RequirePermission } from "../../rbac/require-permission.decorator";
import { AuditReconciliationReportRepository } from "./audit-reconciliation-report.repository";
import { AuditReplayService } from "./audit-replay.service";
import { ReconciliationReportsQueryDto } from "./dto/reconciliation-reports-query.dto";
import { ReplayRequestDto } from "./dto/replay-request.dto";

@Controller("api/v1/audit/reconciliation")
export class AuditReconciliationController {
  constructor(
    private readonly reportRepository: AuditReconciliationReportRepository,
    private readonly replayService: AuditReplayService,
  ) {}

  // AC: "Admin and Compliance Officer only" — the same OR-permission
  // shape as GET /api/v1/audit/logs (WO-047's own precedent for a route
  // shared by roles with different grants).
  @Get("reports")
  @RequireAnyPermission([PermissionName.AUDIT_LOGS_VIEW_ORG, PermissionName.AUDIT_PHI_MONITORING_VIEW])
  async listReports(@Query() query: ReconciliationReportsQueryDto, @Req() req: Request) {
    const reports = await this.reportRepository.findByTenant(
      req.tenantId!,
      { reportType: query.reportType, since: query.since ? new Date(query.since) : undefined, until: query.until ? new Date(query.until) : undefined },
      req.tenantDbClient,
    );
    return { reports };
  }

  // AC: "protected admin API endpoint" — tenant_configuration:rbac:manage
  // is the one existing permission ONLY platform_admin holds (migration
  // 024), matching "Admin-only" exactly rather than reusing a permission
  // compliance_officer also has.
  @Post("replay")
  @RequirePermission(PermissionName.TENANT_RBAC_MANAGE)
  async replay(@Body() dto: ReplayRequestDto, @Req() req: Request) {
    const result = await this.replayService.replayFromDeadLetterQueue(req.tenantId!, new Date(dto.since), new Date(dto.until));
    return result;
  }
}
