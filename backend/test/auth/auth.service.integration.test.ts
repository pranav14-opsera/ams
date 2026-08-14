import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { AuthService } from "../../src/auth/auth.service";
import { SamlService } from "../../src/auth/saml.service";
import { OidcService } from "../../src/auth/oidc.service";
import { SsoConfigRepository } from "../../src/auth/sso-config.repository";
import { InMemoryIdpMetadataCache } from "../../src/auth/in-memory-idp-metadata-cache.service";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { TokenService } from "../../src/auth/token/token.service";
import { InMemoryRefreshTokenStore } from "../../src/auth/token/in-memory-refresh-token-store.service";
import { computeDeviceFingerprint } from "../../src/auth/token/device-fingerprint";
import { SessionService } from "../../src/auth/session/session.service";
import { InMemorySessionStore } from "../../src/auth/session/in-memory-session-store.service";
import { TenantSessionPolicyRepository } from "../../src/auth/session/tenant-session-policy.repository";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { buildSignedSamlResponse, SAML_IDP_CERT_PEM } from "../fixtures/auth/build-saml-fixture";
import { startMockOidcProvider } from "../fixtures/auth/mock-oidc-provider";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const CALLBACK_URL = "https://sp.test/callback";
const USER_AGENT = "integration-test-agent/1.0";
const IP_ADDRESS = "127.0.0.1";

function randomSlug(): string {
  return `test-auth-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenant_sso_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

function buildTestRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const tenantRepo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, tenantRepo, keyMetadataRepo, kms, rbac, audit);
  const encryptionService = new EncryptionService(pool, kms, keyMetadataRepo, audit);
  const ssoConfigRepository = new SsoConfigRepository();
  const samlService = new SamlService(new InMemoryIdpMetadataCache());
  const oidcService = new OidcService(encryptionService);
  const keyService = new JwtKeyService();
  const refreshTokenStore = new InMemoryRefreshTokenStore();
  const sessionService = new SessionService(pool, new InMemorySessionStore(), refreshTokenStore, new TenantSessionPolicyRepository(), audit);
  const tokenService = new TokenService(keyService, refreshTokenStore, rbac, audit, sessionService);
  const verifier = new MultiKeyJwtVerifier(keyService);
  const authService = new AuthService(pool, ssoConfigRepository, samlService, oidcService, tokenService, audit);
  return { saga, ssoConfigRepository, encryptionService, authService, tokenService, sessionService, verifier };
}

test("end-to-end SAML login: provisioned tenant + pre-existing user -> real signed assertion -> platform token pair issued and audited", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, ssoConfigRepository, authService, verifier } = buildTestRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Auth Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const email = `clinician-${randomBytes(4).toString("hex")}@example.com`;
    await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3)", [tenant.id, email, "Test Clinician"]);

    await ssoConfigRepository.upsert(pool, { tenantId: tenant.id, protocol: "saml", samlMetadataUrl: "https://mock-idp.test/metadata", samlEntityId: "ams-platform" });
    await ssoConfigRepository.updateCachedSamlCert(pool, tenant.id, SAML_IDP_CERT_PEM);

    const samlResponse = buildSignedSamlResponse({ nameId: email, groups: ["clinicians"] });
    const tokens = await authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, IP_ADDRESS, USER_AGENT);

    assert.ok(tokens.accessToken);
    assert.ok(tokens.refreshToken);
    const claims = await verifier.verify(tokens.accessToken);
    assert.equal(claims.tenant_id, tenant.id);
    assert.deepEqual(claims.roles, ["clinicians"]);
    assert.equal(claims.mfa_verified, false);

    const userRow = await pool.query("SELECT id, idp_subject FROM users WHERE tenant_id = $1 AND email = $2", [tenant.id, email]);
    assert.equal(userRow.rows[0].idp_subject, email, "idp_subject must be backfilled on first successful SSO login");
    assert.equal(claims.sub, userRow.rows[0].id);

    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'auth.sso.saml.success'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("end-to-end OIDC login against a real mock provider issues a platform token pair", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, ssoConfigRepository, encryptionService, authService } = buildTestRig(pool);
  const slug = randomSlug();
  const provider = await startMockOidcProvider();

  try {
    const tenant = await saga.provision({ name: "OIDC Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const email = `clinician-${randomBytes(4).toString("hex")}@example.com`;
    await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3)", [tenant.id, email, "Test Clinician"]);

    const encryptedSecret = await encryptionService.encrypt(tenant.id, Buffer.from(provider.clientSecret, "utf8"));
    await ssoConfigRepository.upsert(pool, {
      tenantId: tenant.id,
      protocol: "oidc",
      oidcDiscoveryUrl: `${provider.issuerUrl}/.well-known/openid-configuration`,
      oidcClientId: provider.clientId,
      oidcClientSecret: encryptedSecret,
    });

    provider.issueIdToken({ sub: email, email, groups: ["clinicians"] });
    const tokens = await authService.handleOidcCallback(tenant.id, "any-code", CALLBACK_URL, IP_ADDRESS, USER_AGENT);

    assert.ok(tokens.accessToken);
    assert.ok(tokens.refreshToken);
    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'auth.sso.oidc.success'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await provider.close();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a full refresh cycle: the SAML-issued refresh token rotates into a new token pair, and the old one becomes unusable", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, ssoConfigRepository, authService, tokenService } = buildTestRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Refresh Test Co", slug, dataResidencyRegion: "us", actorId: null });
    const email = `clinician-${randomBytes(4).toString("hex")}@example.com`;
    await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3)", [tenant.id, email, "Test Clinician"]);
    await ssoConfigRepository.upsert(pool, { tenantId: tenant.id, protocol: "saml", samlMetadataUrl: "https://mock-idp.test/metadata", samlEntityId: "ams-platform" });
    await ssoConfigRepository.updateCachedSamlCert(pool, tenant.id, SAML_IDP_CERT_PEM);

    const samlResponse = buildSignedSamlResponse({ nameId: email, groups: ["clinicians"] });
    const original = await authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, IP_ADDRESS, USER_AGENT);

    const fingerprint = computeDeviceFingerprint(USER_AGENT, IP_ADDRESS);
    const rotated = await tokenService.refreshTokens(original.refreshToken, fingerprint);

    assert.ok(rotated.accessToken);
    assert.notEqual(rotated.refreshToken, original.refreshToken);

    await assert.rejects(() => tokenService.refreshTokens(original.refreshToken, fingerprint), "the original refresh token must be single-use");

    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'auth.token.refreshed'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a SAML login's access token carries a real session (sid) that SessionValidationMiddleware honors, and rejects once force-logged-out", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, ssoConfigRepository, authService, verifier, sessionService } = buildTestRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Session Integration Co", slug, dataResidencyRegion: "us", actorId: null });
    const email = `clinician-${randomBytes(4).toString("hex")}@example.com`;
    await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3)", [tenant.id, email, "Test Clinician"]);
    await ssoConfigRepository.upsert(pool, { tenantId: tenant.id, protocol: "saml", samlMetadataUrl: "https://mock-idp.test/metadata", samlEntityId: "ams-platform" });
    await ssoConfigRepository.updateCachedSamlCert(pool, tenant.id, SAML_IDP_CERT_PEM);

    const samlResponse = buildSignedSamlResponse({ nameId: email, groups: ["clinicians"] });
    const tokens = await authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, IP_ADDRESS, USER_AGENT);
    const claims = await verifier.verify(tokens.accessToken);
    const sessionId = claims.sid as string;
    assert.ok(sessionId);

    // The session genuinely exists and validates — proves `sid` isn't
    // just an opaque claim, it names a real, checkable session.
    await sessionService.validateSession(sessionId);

    await sessionService.invalidateSession(sessionId, "admin_force_logout");
    await assert.rejects(() => sessionService.validateSession(sessionId));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a valid SAML assertion for a user with NO matching platform user record is rejected generically (401), not treated as an error revealing account existence", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, ssoConfigRepository, authService } = buildTestRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "No User Co", slug, dataResidencyRegion: "us", actorId: null });
    await ssoConfigRepository.upsert(pool, { tenantId: tenant.id, protocol: "saml", samlMetadataUrl: "https://mock-idp.test/metadata", samlEntityId: "ams-platform" });
    await ssoConfigRepository.updateCachedSamlCert(pool, tenant.id, SAML_IDP_CERT_PEM);

    const samlResponse = buildSignedSamlResponse({ nameId: "nobody@example.com" });

    await assert.rejects(
      () => authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, IP_ADDRESS, USER_AGENT),
      (err: any) => {
        assert.equal(err.getStatus(), 401);
        assert.equal(err.getResponse().message, "SSO validation failed.");
        return true;
      },
    );

    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'auth.sso.saml.failure'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a callback for a tenant with no SSO config configured at all is rejected generically", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, authService } = buildTestRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Unconfigured Co", slug, dataResidencyRegion: "us", actorId: null });
    const samlResponse = buildSignedSamlResponse();

    await assert.rejects(
      () => authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, IP_ADDRESS, USER_AGENT),
      (err: any) => {
        assert.equal(err.getStatus(), 401);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
