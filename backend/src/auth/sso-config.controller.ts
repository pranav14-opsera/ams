import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { EncryptionService } from "../encryption/encryption.service";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { ConfigureSsoDto } from "./dto/configure-sso.dto";
import { IdpMetadataService } from "./idp-metadata.service";
import { SsoConfigRepository, type TenantSsoConfig } from "./sso-config.repository";

@Controller("api/v1/tenants/:tenantId/auth/sso")
export class SsoConfigController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ssoConfigRepository: SsoConfigRepository,
    private readonly encryptionService: EncryptionService,
    private readonly idpMetadataService: IdpMetadataService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Post("configure")
  @RequirePermission(PermissionName.TENANT_SSO_CONFIGURE)
  async configure(@Param("tenantId") tenantId: string, @Body() dto: ConfigureSsoDto, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);

    if (dto.protocol === "saml") {
      // Fetched (and validated as parseable) synchronously at configure
      // time, not deferred to first login — a tenant admin should learn
      // immediately if their metadata URL is unreachable or malformed,
      // not have their first end user hit a mysterious 503.
      const certPem = await this.idpMetadataService.fetchSamlSigningCert(dto.samlMetadataUrl!);
      const config = await this.ssoConfigRepository.upsert(this.pool, {
        tenantId,
        protocol: "saml",
        samlMetadataUrl: dto.samlMetadataUrl,
        samlEntityId: dto.samlEntityId,
      });
      await this.ssoConfigRepository.updateCachedSamlCert(this.pool, tenantId, certPem);
      await this.recordConfigChange(tenantId, req.actorId ?? null, "saml");
      return { ...this.omitSecret(config), samlCertPem: certPem };
    }

    if (!dto.oidcClientSecret) {
      throw new BadRequestException("oidcClientSecret is required for the oidc protocol.");
    }
    const encryptedSecret = await this.encryptionService.encrypt(tenantId, Buffer.from(dto.oidcClientSecret, "utf8"));
    const config = await this.ssoConfigRepository.upsert(this.pool, {
      tenantId,
      protocol: "oidc",
      oidcDiscoveryUrl: dto.oidcDiscoveryUrl,
      oidcClientId: dto.oidcClientId,
      oidcClientSecret: encryptedSecret,
    });
    await this.recordConfigChange(tenantId, req.actorId ?? null, "oidc");
    return this.omitSecret(config);
  }

  @Get("config")
  @RequirePermission(PermissionName.TENANT_SSO_CONFIGURE)
  async getConfig(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const config = await this.ssoConfigRepository.findByTenantId(this.pool, tenantId);
    if (!config) {
      throw new BadRequestException("No SSO configuration exists for this tenant yet.");
    }
    return this.omitSecret(config);
  }

  /** Never returns the encrypted secret blob over the API — write-only from the client's perspective. */
  private omitSecret(config: TenantSsoConfig): Omit<TenantSsoConfig, "oidcClientSecret"> {
    const { oidcClientSecret: _secret, ...rest } = config;
    return rest;
  }

  private async recordConfigChange(tenantId: string, actorId: string | null, protocol: "saml" | "oidc"): Promise<void> {
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "auth.sso.config_changed",
      resourceType: "tenant_sso_config",
      resourceId: tenantId,
      details: { protocol },
    });
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot manage SSO configuration for another tenant.");
    }
  }
}
