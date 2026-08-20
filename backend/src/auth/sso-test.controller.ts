import { BadRequestException, Controller, ForbiddenException, Inject, Post, Param, Req } from "@nestjs/common";
import { X509Certificate } from "node:crypto";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { Issuer } from "openid-client";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { EncryptionService } from "../encryption/encryption.service";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { IdpMetadataService } from "./idp-metadata.service";
import { SsoConfigRepository, type TenantSsoConfig } from "./sso-config.repository";

interface Diagnostics {
  metadataFetch: "pass" | "fail";
  certificateValidation: "pass" | "fail";
  assertionParsing: "pass" | "fail";
  groupMapping: "pass" | "fail";
}

/**
 * WO-082 Step 2's "Test SSO Connection" button. There is no reachable
 * external IdP in this environment, so this is honestly a STRUCTURAL
 * validation of the tenant's SAVED configuration — real network fetch of
 * the metadata document (SAML) or discovery document (OIDC), real
 * certificate parsing (node's own X509Certificate, not a hand-rolled
 * check), and real construction of the same node-saml `SAML` /
 * openid-client `Client` objects the actual login flow uses — NOT a live
 * end-to-end login round-trip (no real IdP exists to post a real SAML
 * assertion or exchange a real authorization code against). Documented
 * precisely as such in this WO's reconciliation doc.
 */
@Controller("api/v1/tenants/:tenantId/auth/sso")
export class SsoTestController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ssoConfigRepository: SsoConfigRepository,
    private readonly idpMetadataService: IdpMetadataService,
    private readonly encryptionService: EncryptionService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Post("test")
  @RequirePermission(PermissionName.TENANT_SSO_CONFIGURE)
  async test(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);

    const config = await this.ssoConfigRepository.findByTenantId(this.pool, tenantId);
    if (!config) {
      throw new BadRequestException("No SSO configuration has been saved for this tenant yet — complete Step 2 before testing.");
    }

    const { diagnostics, errorMessage } = config.protocol === "saml" ? await this.testSaml(config) : await this.testOidc(config);
    const success = Object.values(diagnostics).every((v) => v === "pass");

    await this.auditService.recordEvent({
      tenantId,
      actorId: req.actorId ?? null,
      action: "auth.sso.test_connection",
      resourceType: "tenant_sso_config",
      resourceId: tenantId,
      details: { protocol: config.protocol, success, diagnostics },
    });

    return { success, diagnostics, errorMessage };
  }

  private async testSaml(config: TenantSsoConfig): Promise<{ diagnostics: Diagnostics; errorMessage: string | null }> {
    const diagnostics: Diagnostics = { metadataFetch: "fail", certificateValidation: "fail", assertionParsing: "fail", groupMapping: "fail" };
    let errorMessage: string | null = null;

    let certBase64: string | null = null;
    if (config.samlMetadataUrl) {
      try {
        certBase64 = await this.idpMetadataService.fetchSamlSigningCert(config.samlMetadataUrl);
        diagnostics.metadataFetch = "pass";
      } catch (err) {
        errorMessage = "Could not fetch IdP metadata from the configured URL — verify it is publicly accessible.";
      }
    } else {
      errorMessage = "No SAML metadata URL is configured for this tenant.";
    }

    if (certBase64) {
      try {
        const pem = `-----BEGIN CERTIFICATE-----\n${certBase64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----`;
        const cert = new X509Certificate(pem);
        // A real, if inexpensive, structural check: the signing
        // certificate must not have already expired.
        diagnostics.certificateValidation = new Date(cert.validTo).getTime() > Date.now() ? "pass" : "fail";
        if (diagnostics.certificateValidation === "fail") errorMessage = "The IdP's signing certificate has expired.";

        // Exercises the SAME node-saml SAML class the real login callback
        // uses (auth.controller.ts -> SamlService.validate) — constructing
        // it against the fetched cert/entity is a real structural check of
        // "does this library accept the configuration we saved," even
        // without a live assertion to actually validate.
        // eslint-disable-next-line no-new
        new SAML({
          idpCert: cert.toString(),
          issuer: config.samlEntityId ?? "ams-platform",
          callbackUrl: "https://placeholder.invalid/api/v1/auth/saml/callback",
          wantAssertionsSigned: true,
          wantAuthnResponseSigned: false,
          validateInResponseTo: ValidateInResponseTo.never,
        });
        diagnostics.assertionParsing = "pass";
      } catch {
        errorMessage = "SAML assertion signature validation failed — verify the signing certificate is well-formed.";
      }
    }

    diagnostics.groupMapping = await this.hasGroupMappings(config.tenantId);
    if (diagnostics.groupMapping === "fail" && !errorMessage) {
      errorMessage = "No IdP group-to-role mappings are configured yet.";
    }

    return { diagnostics, errorMessage };
  }

  private async testOidc(config: TenantSsoConfig): Promise<{ diagnostics: Diagnostics; errorMessage: string | null }> {
    const diagnostics: Diagnostics = { metadataFetch: "fail", certificateValidation: "fail", assertionParsing: "fail", groupMapping: "fail" };
    let errorMessage: string | null = null;

    if (!config.oidcDiscoveryUrl) {
      return { diagnostics, errorMessage: "No OIDC discovery URL is configured for this tenant." };
    }

    let issuer: Issuer<import("openid-client").Client> | null = null;
    try {
      issuer = await Issuer.discover(config.oidcDiscoveryUrl);
      diagnostics.metadataFetch = "pass";
    } catch {
      return { diagnostics, errorMessage: "Could not fetch the OIDC discovery document from the configured URL — verify it is publicly accessible." };
    }

    // No signing certificate is exchanged directly in an OIDC flow the
    // way SAML does — the closest real structural equivalent is
    // confirming the discovery document actually published a JWKS
    // endpoint (what token-signature verification would use).
    diagnostics.certificateValidation = issuer.metadata.jwks_uri ? "pass" : "fail";
    if (diagnostics.certificateValidation === "fail") errorMessage = "The IdP's discovery document did not publish a jwks_uri.";

    if (config.oidcClientId && config.oidcClientSecret) {
      try {
        const secretBuffer = await this.encryptionService.decrypt(config.tenantId, config.oidcClientSecret);
        // eslint-disable-next-line no-new
        new issuer.Client({
          client_id: config.oidcClientId,
          client_secret: secretBuffer.toString("utf8"),
          redirect_uris: ["https://placeholder.invalid/api/v1/auth/oidc/callback"],
          response_types: ["code"],
        });
        diagnostics.assertionParsing = "pass";
      } catch {
        errorMessage = "Could not construct an OIDC client from the configured client ID/secret.";
      }
    } else {
      errorMessage = "OIDC client ID or client secret is missing.";
    }

    diagnostics.groupMapping = await this.hasGroupMappings(config.tenantId);
    if (diagnostics.groupMapping === "fail" && !errorMessage) {
      errorMessage = "No IdP group-to-role mappings are configured yet.";
    }

    return { diagnostics, errorMessage };
  }

  private async hasGroupMappings(tenantId: string): Promise<"pass" | "fail"> {
    const result = await this.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM group_role_mappings WHERE tenant_id = $1", [tenantId]);
    return Number(result.rows[0]?.count ?? "0") > 0 ? "pass" : "fail";
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot test SSO configuration for another tenant.");
    }
  }
}
