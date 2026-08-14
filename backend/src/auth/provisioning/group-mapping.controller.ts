import { Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { UpsertGroupMappingDto } from "./dto/upsert-group-mapping.dto";
import { GroupRoleMappingRepository } from "./group-role-mapping.repository";

@Controller("api/v1/tenants/:tenantId/group-mappings")
export class GroupMappingController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: GroupRoleMappingRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Get()
  async list(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    return this.repository.list(this.pool, tenantId);
  }

  @Post()
  async upsert(@Param("tenantId") tenantId: string, @Body() dto: UpsertGroupMappingDto, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const mapping = await this.repository.upsert(this.pool, tenantId, dto.idpGroup, dto.platformRole, dto.priority);

    await this.auditService.recordEvent({
      tenantId,
      actorId: req.actorId ?? null,
      action: "auth.group_mapping.upserted",
      resourceType: "group_role_mapping",
      resourceId: mapping.id,
      details: { idpGroup: dto.idpGroup, platformRole: dto.platformRole, priority: dto.priority },
    });

    return mapping;
  }

  @Delete(":id")
  async remove(@Param("tenantId") tenantId: string, @Param("id") id: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const deleted = await this.repository.delete(this.pool, tenantId, id);
    if (!deleted) {
      throw new NotFoundException("No group mapping with that id for this tenant.");
    }

    await this.auditService.recordEvent({
      tenantId,
      actorId: req.actorId ?? null,
      action: "auth.group_mapping.deleted",
      resourceType: "group_role_mapping",
      resourceId: id,
      details: {},
    });

    return { deleted: true };
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot manage group mappings for another tenant.");
    }
  }
}
