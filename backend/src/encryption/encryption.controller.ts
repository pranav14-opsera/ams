import { Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { EncryptionService } from "./encryption.service";

// Scoped the same way TenantsController is: the requesting user's own
// tenant (from their validated JWT via TenantContextMiddleware) must match
// the :id path param. There's no dedicated RBAC/permission-check layer in
// this codebase yet (that's WO-018+'s scope) — this is the same
// enforcement point WO-013 already established for the rest of the
// tenants API, not a new pattern invented here.
@Controller("api/v1/tenants/:id/encryption")
export class EncryptionController {
  constructor(private readonly encryptionService: EncryptionService) {}

  @Get("status")
  async getStatus(@Param("id") id: string, @Req() req: Request) {
    this.requireOwnTenant(id, req);
    return this.encryptionService.getStatus(id);
  }

  @Post("rotate")
  @HttpCode(HttpStatus.OK)
  async rotate(@Param("id") id: string, @Req() req: Request) {
    this.requireOwnTenant(id, req);
    return this.encryptionService.rotate(id, req.actorId ?? null);
  }

  @Post("schedule-deletion")
  @HttpCode(HttpStatus.OK)
  async scheduleDeletion(@Param("id") id: string, @Req() req: Request) {
    this.requireOwnTenant(id, req);
    return this.encryptionService.scheduleDeletion(id, req.actorId ?? null);
  }

  @Post("cancel-deletion")
  @HttpCode(HttpStatus.OK)
  async cancelDeletion(@Param("id") id: string, @Req() req: Request) {
    this.requireOwnTenant(id, req);
    return this.encryptionService.cancelDeletion(id, req.actorId ?? null);
  }

  private requireOwnTenant(id: string, req: Request): void {
    if (req.tenantId !== id) {
      // 403, not 404: unlike TenantsController's cross-tenant reads (which
      // 404 to avoid confirming another tenant's id exists), key lifecycle
      // operations are destructive/irreversible enough that a clear,
      // loud rejection is more useful here than existence-hiding.
      throw new ForbiddenException("Cannot manage encryption keys for another tenant.");
    }
  }
}
