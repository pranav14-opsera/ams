import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequireAnyPermission } from "../../rbac/require-any-permission.decorator";
import { AuditLogQueryService } from "./audit-log-query.service";
import { AuditLogQueryDto } from "./dto/audit-log-query.dto";

@Controller("api/v1/audit")
export class AuditLogController {
  constructor(private readonly queryService: AuditLogQueryService) {}

  @Get("logs")
  @RequireAnyPermission([PermissionName.AUDIT_LOGS_VIEW_ORG, PermissionName.AUDIT_LOGS_VIEW_TEAM])
  async listLogs(@Query() query: AuditLogQueryDto, @Req() req: Request) {
    const result = await this.queryService.query({ tenantId: req.tenantId!, actorId: req.actorId!, permissions: req.permissions ?? [] }, query, req.tenantDbClient);
    return {
      entries: result.entries,
      nextCursor: result.nextCursor,
      scope: result.restrictedToTeamScope ? "team" : "org",
    };
  }
}
