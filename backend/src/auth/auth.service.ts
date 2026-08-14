import { ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { DataClassification } from "../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { SamlService, type SsoIdentity } from "./saml.service";
import { OidcService } from "./oidc.service";
import { SsoConfigRepository, type TenantSsoConfig } from "./sso-config.repository";
import { computeDeviceFingerprint } from "./token/device-fingerprint";
import { TokenService, type TokenPair } from "./token/token.service";
import { JitProvisioningService } from "./provisioning/jit-provisioning.service";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ssoConfigRepository: SsoConfigRepository,
    private readonly samlService: SamlService,
    private readonly oidcService: OidcService,
    private readonly tokenService: TokenService,
    private readonly jitProvisioningService: JitProvisioningService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async handleSamlCallback(
    tenantId: string,
    samlResponse: string,
    callbackUrl: string,
    ipAddress: string | null,
    userAgent: string,
  ): Promise<TokenPair> {
    return this.handleCallback(tenantId, "saml", ipAddress, userAgent, (config) => this.samlService.validate(config, samlResponse, callbackUrl));
  }

  async handleOidcCallback(tenantId: string, code: string, callbackUrl: string, ipAddress: string | null, userAgent: string): Promise<TokenPair> {
    return this.handleCallback(tenantId, "oidc", ipAddress, userAgent, (config) => this.oidcService.validate(config, code, callbackUrl));
  }

  private async handleCallback(
    tenantId: string,
    protocol: "saml" | "oidc",
    ipAddress: string | null,
    userAgent: string,
    validate: (config: TenantSsoConfig) => Promise<SsoIdentity>,
  ): Promise<TokenPair> {
    const correlationId = randomUUID();
    const deviceFingerprint = computeDeviceFingerprint(userAgent, ipAddress ?? "unknown");
    try {
      const config = await this.ssoConfigRepository.findByTenantId(this.pool, tenantId);
      if (!config || config.protocol !== protocol) {
        await this.recordAuthEvent(tenantId, null, protocol, "failure", ipAddress, correlationId);
        throw new UnauthorizedException("SSO validation failed.");
      }

      const identity = await validate(config);
      const { userId, role } = await this.jitProvisioningService.provisionOrUpdate(tenantId, identity.subject, identity.email, null, identity.groups);

      // The JWT's `roles` claim carries the JIT-resolved platform role
      // (WO-022), not the raw IdP group names — those are tenant-internal
      // vocabulary ("clinicians", "org:eng") that the CHECK constraint on
      // rbac_policies.role would reject, and permission lookup keys off
      // the platform role. Deny-by-default means an empty array, not the
      // raw groups, when no mapping matched.
      const tokenPair = await this.tokenService.issueTokenPair(userId, tenantId, role ? [role] : [], deviceFingerprint);
      await this.recordAuthEvent(tenantId, userId, protocol, "success", ipAddress, correlationId);
      return tokenPair;
    } catch (err) {
      if (err instanceof UnauthorizedException || err instanceof ForbiddenException) {
        await this.recordAuthEvent(tenantId, null, protocol, "failure", ipAddress, correlationId).catch(() => undefined);
        throw err;
      }
      this.logger.error(`SSO callback failed [${correlationId}] (tenant=${tenantId}, protocol=${protocol}): ${err instanceof Error ? err.stack : err}`);
      await this.recordAuthEvent(tenantId, null, protocol, "failure", ipAddress, correlationId).catch(() => undefined);
      throw new ServiceUnavailableException({ message: "SSO provider unreachable.", correlationId });
    }
  }

  private async recordAuthEvent(
    tenantId: string,
    actorId: string | null,
    protocol: "saml" | "oidc",
    outcome: "success" | "failure",
    ipAddress: string | null,
    correlationId: string,
  ): Promise<void> {
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: `auth.sso.${protocol}.${outcome}`,
      resourceType: "auth_session",
      resourceId: actorId ?? tenantId,
      details: { idpType: protocol, outcome, ipAddress, correlationId },
      dataClassification: DataClassification.CONFIDENTIAL,
    });
  }
}
