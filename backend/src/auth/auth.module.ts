import { Module } from "@nestjs/common";
import { EncryptionModule } from "../encryption/encryption.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { IDP_METADATA_CACHE } from "./idp-metadata-cache.port";
import { InMemoryIdpMetadataCache } from "./in-memory-idp-metadata-cache.service";
import { IdpMetadataService } from "./idp-metadata.service";
import { JWT_ISSUER } from "./jwt/jwt-issuer.port";
import { Rs256JwtIssuerService } from "./jwt/rs256-jwt-issuer.service";
import { OidcService } from "./oidc.service";
import { SamlService } from "./saml.service";
import { SsoConfigController } from "./sso-config.controller";
import { SsoConfigRepository } from "./sso-config.repository";

@Module({
  imports: [EncryptionModule],
  controllers: [AuthController, SsoConfigController],
  providers: [
    AuthService,
    SamlService,
    OidcService,
    SsoConfigRepository,
    IdpMetadataService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    { provide: IDP_METADATA_CACHE, useClass: InMemoryIdpMetadataCache },
    {
      provide: JWT_ISSUER,
      // Signs locally with an RSA private key — production signs via AWS
      // KMS's asymmetric Sign API against the same jwt-signing key
      // (infrastructure/terraform/kms/jwt-signing.tf, WO-003); not
      // implemented here, same connector-gap pattern as this codebase's
      // other AWS-KMS-shaped gaps. See jwt-issuer.port.ts's header.
      useFactory: () => new Rs256JwtIssuerService(process.env.JWT_PRIVATE_KEY_PEM ?? ""),
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
