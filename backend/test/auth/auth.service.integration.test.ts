import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { AuthService } from "../../src/auth/auth.service";
import { SamlService } from "../../src/auth/saml.service";
import { OidcService } from "../../src/auth/oidc.service";
import { SsoConfigRepository } from "../../src/auth/sso-config.repository";
import { InMemoryIdpMetadataCache } from "../../src/auth/in-memory-idp-metadata-cache.service";
import { Rs256JwtIssuerService } from "../../src/auth/jwt/rs256-jwt-issuer.service";
import { Rs256JwtVerifier } from "../../src/common/jwt/rs256-jwt-verifier.service";
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
  const jwtIssuer = new Rs256JwtIssuerService(TEST_JWT_PRIVATE_KEY);
  const authService = new AuthService(pool, ssoConfigRepository, samlService, oidcService, jwtIssuer, audit);
  return { saga, ssoConfigRepository, encryptionService, authService };
}

// Fixed test key pair so both the issuer (built above) and the verifier
// (used to assert the returned token is real and well-formed) agree.
const { publicKey: TEST_JWT_PUBLIC_KEY, privateKey: TEST_JWT_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("end-to-end SAML login: provisioned tenant + pre-existing user -> real signed assertion -> platform JWT issued and audited", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, ssoConfigRepository, authService } = buildTestRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Auth Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const email = `clinician-${randomBytes(4).toString("hex")}@example.com`;
    await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3)", [tenant.id, email, "Test Clinician"]);

    await ssoConfigRepository.upsert(pool, { tenantId: tenant.id, protocol: "saml", samlMetadataUrl: "https://mock-idp.test/metadata", samlEntityId: "ams-platform" });
    await ssoConfigRepository.updateCachedSamlCert(pool, tenant.id, SAML_IDP_CERT_PEM);

    const samlResponse = buildSignedSamlResponse({ nameId: email, groups: ["clinicians"] });
    const token = await authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, "127.0.0.1");

    assert.ok(token);
    const verifier = new Rs256JwtVerifier(TEST_JWT_PUBLIC_KEY);
    const claims = await verifier.verify(token);
    assert.equal(claims.tenant_id, tenant.id);

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

test("end-to-end OIDC login against a real mock provider issues a platform JWT", { skip }, async () => {
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
    const token = await authService.handleOidcCallback(tenant.id, "any-code", CALLBACK_URL, "127.0.0.1");

    assert.ok(token);
    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'auth.sso.oidc.success'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await provider.close();
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
      () => authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, "127.0.0.1"),
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
      () => authService.handleSamlCallback(tenant.id, samlResponse, CALLBACK_URL, "127.0.0.1"),
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
