import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { UpdateMfaPolicyDto } from "./dto/update-mfa-policy.dto";
import { DEFAULT_MFA_POLICY, TenantMfaPolicyRepository } from "./tenant-mfa-policy.repository";

@Controller("api/v1/tenants/:tenantId/mfa-policy")
export class MfaPolicyController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly policyRepository: TenantMfaPolicyRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Get()
  async getPolicy(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const policy = await this.policyRepository.findByTenantId(this.pool, tenantId);
    return policy ?? { tenantId, ...DEFAULT_MFA_POLICY };
  }

  @Patch()
  async updatePolicy(@Param("tenantId") tenantId: string, @Body() dto: UpdateMfaPolicyDto, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const policy = await this.policyRepository.upsert(this.pool, tenantId, dto);

    await this.auditService.recordEvent({
      tenantId,
      actorId: req.actorId ?? null,
      action: "auth.mfa_policy.updated",
      resourceType: "tenant_mfa_policy",
      resourceId: tenantId,
      details: { ...dto },
    });

    return policy;
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot manage MFA policy for another tenant.");
    }
  }
}
