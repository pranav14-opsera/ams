import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { CreateScimTokenDto } from "./dto/create-scim-token.dto";
import { ScimTokenRepository } from "./scim-token.repository";

// Admin-only management of a tenant's SCIM bearer tokens. Scoped by
// :tenantId in the path (matching every other tenant-admin controller in
// this codebase — SsoConfigController, MfaPolicyController, etc.), not
// the flat /api/v1/auth/scim/tokens path this WO's own description
// mentions, for the same convention-consistency reasons those controllers
// already established.
@Controller("api/v1/tenants/:tenantId/scim/tokens")
export class ScimTokenController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tokenRepository: ScimTokenRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.SCIM_TOKEN_MANAGE)
  async create(@Param("tenantId") tenantId: string, @Body() dto: CreateScimTokenDto, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const { rawToken, record } = await this.tokenRepository.generate(this.pool, tenantId, dto.description ?? null, req.actorId ?? null);

    await this.auditService.recordEvent({
      tenantId,
      actorId: req.actorId ?? null,
      action: "scim.token_created",
      resourceType: "scim_token",
      resourceId: record.id,
      details: { description: dto.description ?? null },
    });

    // The raw token is returned ONLY in this response — never again, and
    // never persisted anywhere but as its SHA-256 hash.
    return { id: record.id, description: record.description, createdAt: record.createdAt, token: rawToken };
  }

  @Get()
  @RequirePermission(PermissionName.SCIM_TOKEN_MANAGE)
  async list(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const tokens = await this.tokenRepository.list(this.pool, tenantId);
    return tokens.map((t) => ({ id: t.id, description: t.description, createdAt: t.createdAt, revokedAt: t.revokedAt }));
  }

  @Delete(":id")
  @RequirePermission(PermissionName.SCIM_TOKEN_MANAGE)
  async revoke(@Param("tenantId") tenantId: string, @Param("id") id: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const revoked = await this.tokenRepository.revoke(this.pool, tenantId, id);

    if (revoked) {
      await this.auditService.recordEvent({
        tenantId,
        actorId: req.actorId ?? null,
        action: "scim.token_revoked",
        resourceType: "scim_token",
        resourceId: id,
        details: {},
      });
    }

    return { revoked };
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot manage SCIM tokens for another tenant.");
    }
  }
}
