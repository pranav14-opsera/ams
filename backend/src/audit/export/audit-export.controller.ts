import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequirePermission } from "../../rbac/require-permission.decorator";
import { AuditExportService } from "./audit-export.service";
import { CreateAuditExportDto } from "./dto/create-audit-export.dto";

@Controller("api/v1/audit/exports")
export class AuditExportController {
  constructor(private readonly exportService: AuditExportService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(PermissionName.REPORTING_AUDIT_SUMMARY_EXPORT)
  async createExport(@Body() dto: CreateAuditExportDto, @Req() req: Request) {
    const job = await this.exportService.requestExport(req.tenantId!, req.actorId!, dto, req.tenantDbClient);
    return { jobId: job.id, status: job.status };
  }

  @Get(":id")
  @RequirePermission(PermissionName.REPORTING_AUDIT_SUMMARY_EXPORT)
  async getExport(@Param("id") id: string, @Req() req: Request) {
    const job = await this.exportService.getJob(req.tenantId!, id, req.tenantDbClient);
    if (!job) throw new NotFoundException(`No export job "${id}" found for this tenant.`);
    return {
      jobId: job.id,
      status: job.status,
      recordCount: job.recordCount,
      downloadUrl: job.status === "completed" ? job.downloadUrl : null,
      downloadUrlExpiresAt: job.status === "completed" ? job.downloadUrlExpiresAt : null,
      errorMessage: job.status === "failed" ? job.errorMessage : null,
    };
  }
}
