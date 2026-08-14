import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequirePermission } from "../../rbac/require-permission.decorator";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { UpdateSessionPolicyDto } from "./dto/update-session-policy.dto";
import { DEFAULT_SESSION_POLICY, TenantSessionPolicyRepository } from "./tenant-session-policy.repository";

@Controller("api/v1/tenants/:tenantId/session-policy")
export class SessionPolicyController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly policyRepository: TenantSessionPolicyRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Get()
  @RequirePermission(PermissionName.TENANT_SESSION_POLICY_CONFIGURE)
  async getPolicy(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const policy = await this.policyRepository.findByTenantId(this.pool, tenantId);
    return policy ?? { tenantId, ...DEFAULT_SESSION_POLICY };
  }

  @Patch()
  @RequirePermission(PermissionName.TENANT_SESSION_POLICY_CONFIGURE)
  async updatePolicy(@Param("tenantId") tenantId: string, @Body() dto: UpdateSessionPolicyDto, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const policy = await this.policyRepository.upsert(this.pool, tenantId, dto.idleTimeoutSeconds, dto.absoluteTimeoutSeconds);

    await this.auditService.recordEvent({
      tenantId,
      actorId: req.actorId ?? null,
      action: "auth.session_policy.updated",
      resourceType: "tenant_session_policy",
      resourceId: tenantId,
      details: { idleTimeoutSeconds: dto.idleTimeoutSeconds, absoluteTimeoutSeconds: dto.absoluteTimeoutSeconds },
    });

    return policy;
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot manage session policy for another tenant.");
    }
  }
}
