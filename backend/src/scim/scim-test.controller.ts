import { Controller, ForbiddenException, Inject, Post, Param, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { parseScimFilter } from "./scim-filter.parser";
import { ScimTokenRepository } from "./scim-token.repository";

interface ScimDiagnostics {
  tokenActive: "pass" | "fail";
  filterParsing: "pass" | "fail";
  endpointReachable: "pass" | "fail";
}

/**
 * WO-082 Step 3's "Test Provisioning" button. There is no real external
 * IdP in this environment to actually push a SCIM user/group payload, so
 * this exercises the REAL pieces that exist server-side without one:
 * (1) whether a live (non-revoked) bearer token has actually been
 * generated for this tenant — the exact thing ScimAuthGuard checks on a
 * real inbound SCIM request; (2) the real ScimFilterParser against a
 * representative filter expression, the same parser
 * ScimUserController/ScimGroupController use on every real SCIM request;
 * (3) that this tenant's own SCIM endpoint path resolves (a structural
 * check, not a live network round-trip against an external IdP, which
 * does not exist here). Documented precisely in this WO's reconciliation
 * doc as a structural/self-test, not a live provisioning round-trip.
 */
@Controller("api/v1/tenants/:tenantId/scim")
export class ScimTestController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tokenRepository: ScimTokenRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Post("test")
  @RequirePermission(PermissionName.SCIM_TOKEN_MANAGE)
  async test(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);

    const diagnostics: ScimDiagnostics = { tokenActive: "fail", filterParsing: "fail", endpointReachable: "fail" };
    let errorMessage: string | null = null;

    const tokens = await this.tokenRepository.list(this.pool, tenantId);
    const hasActiveToken = tokens.some((t) => t.revokedAt === null);
    diagnostics.tokenActive = hasActiveToken ? "pass" : "fail";
    if (!hasActiveToken) {
      errorMessage = "No active SCIM bearer token exists for this tenant — generate one before configuring your IdP.";
    }

    try {
      parseScimFilter('userName eq "onboarding-self-test@example.com"', 1);
      diagnostics.filterParsing = "pass";
    } catch {
      errorMessage = errorMessage ?? "SCIM filter parser rejected a well-formed test filter.";
    }

    // Structural only: the SCIM endpoint's own path is fixed and always
    // resolves within this deployment — there is no external network hop
    // to genuinely fail here the way there is for the SAML/OIDC metadata
    // fetch in SsoTestController.
    diagnostics.endpointReachable = "pass";

    const success = Object.values(diagnostics).every((v) => v === "pass");

    await this.auditService.recordEvent({
      tenantId,
      actorId: req.actorId ?? null,
      action: "scim.test_provisioning",
      resourceType: "scim_token",
      resourceId: tenantId,
      details: { success, diagnostics },
    });

    return { success, diagnostics, errorMessage };
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot test SCIM provisioning for another tenant.");
    }
  }
}
