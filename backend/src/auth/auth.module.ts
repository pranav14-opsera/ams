import { Module } from "@nestjs/common";
import { EncryptionModule } from "../encryption/encryption.module";
import { JWT_VERIFIER } from "../common/jwt/jwt-verifier.port";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { RBAC_SERVICE } from "../tenants/ports/rbac-service.port";
import { PostgresRbacService } from "../tenants/ports/postgres/postgres-rbac.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { IDP_METADATA_CACHE } from "./idp-metadata-cache.port";
import { InMemoryIdpMetadataCache } from "./in-memory-idp-metadata-cache.service";
import { IdpMetadataService } from "./idp-metadata.service";
import { JwtKeyService } from "./jwt/jwt-key.service";
import { JwksController } from "./jwt/jwks.controller";
import { MultiKeyJwtVerifier } from "./jwt/multi-key-jwt-verifier.service";
import { InMemoryMfaRateLimiter } from "./mfa/in-memory-mfa-rate-limiter.service";
import { MFA_RATE_LIMITER } from "./mfa/mfa-rate-limiter.port";
import { MfaController } from "./mfa/mfa.controller";
import { MfaPolicyController } from "./mfa/mfa-policy.controller";
import { MfaService } from "./mfa/mfa.service";
import { MfaStepUpGuard } from "./mfa/mfa-step-up.guard";
import { TenantMfaPolicyRepository } from "./mfa/tenant-mfa-policy.repository";
import { TotpProviderService } from "./mfa/totp-provider.service";
import { UserMfaConfigRepository } from "./mfa/user-mfa-config.repository";
import { OidcService } from "./oidc.service";
import { SamlService } from "./saml.service";
import { SessionPolicyController } from "./session/session-policy.controller";
import { SessionService } from "./session/session.service";
import { SessionValidationMiddleware } from "./session/session-validation.middleware";
import { SESSION_STORE } from "./session/session-store.port";
import { InMemorySessionStore } from "./session/in-memory-session-store.service";
import { TenantSessionPolicyRepository } from "./session/tenant-session-policy.repository";
import { SsoConfigController } from "./sso-config.controller";
import { SsoConfigRepository } from "./sso-config.repository";
import { REFRESH_TOKEN_STORE } from "./token/refresh-token-store.port";
import { InMemoryRefreshTokenStore } from "./token/in-memory-refresh-token-store.service";
import { TokenService } from "./token/token.service";

@Module({
  imports: [EncryptionModule],
  controllers: [AuthController, SsoConfigController, JwksController, SessionPolicyController, MfaController, MfaPolicyController],
  providers: [
    AuthService,
    SamlService,
    OidcService,
    TokenService,
    SessionService,
    SessionValidationMiddleware,
    TenantSessionPolicyRepository,
    SsoConfigRepository,
    IdpMetadataService,
    JwtKeyService,
    MfaService,
    MfaStepUpGuard,
    TotpProviderService,
    UserMfaConfigRepository,
    TenantMfaPolicyRepository,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    { provide: RBAC_SERVICE, useClass: PostgresRbacService },
    { provide: IDP_METADATA_CACHE, useClass: InMemoryIdpMetadataCache },
    { provide: REFRESH_TOKEN_STORE, useClass: InMemoryRefreshTokenStore },
    { provide: SESSION_STORE, useClass: InMemorySessionStore },
    { provide: MFA_RATE_LIMITER, useClass: InMemoryMfaRateLimiter },
    // WO-019 supersedes WO-018/WO-013's static-single-key JWT_VERIFIER:
    // JwtKeyService is the one shared instance that both signs (via
    // TokenService) and verifies (via MultiKeyJwtVerifier) — provided
    // here, in the SAME module, rather than in AppModule with its own
    // separate key material, specifically so a token this module just
    // issued is guaranteed verifiable by the SAME key generation set
    // TenantContextMiddleware checks it against.
    { provide: JWT_VERIFIER, useClass: MultiKeyJwtVerifier },
  ],
  exports: [AuthService, JWT_VERIFIER, JwtKeyService, SessionValidationMiddleware, MfaStepUpGuard],
})
export class AuthModule {}
