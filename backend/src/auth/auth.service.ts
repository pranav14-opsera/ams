import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { DataClassification } from "../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { JWT_ISSUER, type JwtIssuerPort } from "./jwt/jwt-issuer.port";
import { SamlService, type SsoIdentity } from "./saml.service";
import { OidcService } from "./oidc.service";
import { SsoConfigRepository, type TenantSsoConfig } from "./sso-config.repository";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ssoConfigRepository: SsoConfigRepository,
    private readonly samlService: SamlService,
    private readonly oidcService: OidcService,
    @Inject(JWT_ISSUER) private readonly jwtIssuer: JwtIssuerPort,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async handleSamlCallback(tenantId: string, samlResponse: string, callbackUrl: string, ipAddress: string | null): Promise<string> {
    return this.handleCallback(tenantId, "saml", ipAddress, (config) => this.samlService.validate(config, samlResponse, callbackUrl));
  }

  async handleOidcCallback(tenantId: string, code: string, callbackUrl: string, ipAddress: string | null): Promise<string> {
    return this.handleCallback(tenantId, "oidc", ipAddress, (config) => this.oidcService.validate(config, code, callbackUrl));
  }

  private async handleCallback(
    tenantId: string,
    protocol: "saml" | "oidc",
    ipAddress: string | null,
    validate: (config: TenantSsoConfig) => Promise<SsoIdentity>,
  ): Promise<string> {
    const correlationId = randomUUID();
    try {
      const config = await this.ssoConfigRepository.findByTenantId(this.pool, tenantId);
      if (!config || config.protocol !== protocol) {
        await this.recordAuthEvent(tenantId, null, protocol, "failure", ipAddress, correlationId);
        throw new UnauthorizedException("SSO validation failed.");
      }

      const identity = await validate(config);
      const userId = await this.resolveUserId(tenantId, identity);

      if (!userId) {
        await this.recordAuthEvent(tenantId, null, protocol, "failure", ipAddress, correlationId);
        // Generic 401 — does not reveal whether the SSO exchange itself
        // failed or simply no matching platform user exists yet (JIT
        // auto-provisioning is WO-022's separate scope; this WO requires
        // a pre-existing user record, matched by idp_subject or email).
        throw new UnauthorizedException("SSO validation failed.");
      }

      const token = await this.jwtIssuer.issue({ sub: userId, tenant_id: tenantId, groups: identity.groups, idp_type: protocol });
      await this.recordAuthEvent(tenantId, userId, protocol, "success", ipAddress, correlationId);
      return token;
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      this.logger.error(`SSO callback failed [${correlationId}] (tenant=${tenantId}, protocol=${protocol}): ${err instanceof Error ? err.stack : err}`);
      await this.recordAuthEvent(tenantId, null, protocol, "failure", ipAddress, correlationId).catch(() => undefined);
      throw new ServiceUnavailableException({ message: "SSO provider unreachable.", correlationId });
    }
  }

  /** idp_subject match first (a user already linked to this IdP identity), falling back to email (first SSO login for a pre-provisioned user) and backfilling idp_subject. Full JIT auto-creation is WO-022. */
  private async resolveUserId(tenantId: string, identity: SsoIdentity): Promise<string | null> {
    const bySubject = await this.pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1 AND idp_subject = $2", [
      tenantId,
      identity.subject,
    ]);
    if (bySubject.rows[0]) return bySubject.rows[0].id;

    if (!identity.email) return null;
    const byEmail = await this.pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1 AND email = $2", [tenantId, identity.email]);
    if (!byEmail.rows[0]) return null;

    await this.pool.query("UPDATE users SET idp_subject = $1, last_login_at = now() WHERE id = $2", [identity.subject, byEmail.rows[0].id]);
    return byEmail.rows[0].id;
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
