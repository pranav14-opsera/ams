import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { Pool } from "pg";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { IdpMetadataService } from "../../src/auth/idp-metadata.service";
import { SsoConfigRepository } from "../../src/auth/sso-config.repository";
import { SsoTestController } from "../../src/auth/sso-test.controller";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { buildSamlMetadataXml } from "../fixtures/auth/build-saml-fixture";
import { startMockOidcProvider } from "../fixtures/auth/mock-oidc-provider";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-sso-test-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM tenant_sso_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM group_role_mappings WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenant(pool: Pool, slug: string, kms: InMemoryKmsService) {
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  return saga.provision({ name: "SSO Test Tenant", slug, dataResidencyRegion: "us", actorId: null });
}

test("real Postgres + real local HTTP server: SAML test connection passes every diagnostic once metadata/cert/group-mapping are all genuinely in place", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const ssoConfigRepository = new SsoConfigRepository();
  const idpMetadataService = new IdpMetadataService();
  const kms = new InMemoryKmsService();
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), new InMemoryAuditService());
  const controller = new SsoTestController(pool, ssoConfigRepository, idpMetadataService, encryptionService, new PostgresAuditService(pool));

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(buildSamlMetadataXml());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const tenant = await provisionTenant(pool, slug, kms);
    await ssoConfigRepository.upsert(pool, { tenantId: tenant.id, protocol: "saml", samlMetadataUrl: `http://127.0.0.1:${port}/metadata`, samlEntityId: "ams-platform" });
    await pool.query("INSERT INTO group_role_mappings (tenant_id, idp_group, platform_role, priority) VALUES ($1, 'Engineering', 'platform_admin', 0)", [tenant.id]);

    const req = { tenantId: tenant.id, actorId: null } as any;
    const result = await controller.test(tenant.id, req);

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.diagnostics.metadataFetch, "pass");
    assert.equal(result.diagnostics.certificateValidation, "pass");
    assert.equal(result.diagnostics.assertionParsing, "pass");
    assert.equal(result.diagnostics.groupMapping, "pass");

    const auditRows = await pool.query("SELECT * FROM audit_events WHERE tenant_id = $1 AND action = 'auth.sso.test_connection'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: SAML test connection fails cleanly with a diagnostic message when the metadata URL is unreachable", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const ssoConfigRepository = new SsoConfigRepository();
  const idpMetadataService = new IdpMetadataService();
  const kms = new InMemoryKmsService();
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), new InMemoryAuditService());
  const controller = new SsoTestController(pool, ssoConfigRepository, idpMetadataService, encryptionService, new PostgresAuditService(pool));

  try {
    const tenant = await provisionTenant(pool, slug, kms);
    // Directly writes the row (bypassing SsoConfigController.configure, which would itself throw on an unreachable URL) — this exercises the TEST endpoint's own unreachable-URL handling.
    await pool.query(
      "INSERT INTO tenant_sso_configs (tenant_id, protocol, saml_metadata_url, saml_entity_id) VALUES ($1, 'saml', 'http://127.0.0.1:1/metadata', 'ams-platform')",
      [tenant.id],
    );

    const req = { tenantId: tenant.id, actorId: null } as any;
    const result = await controller.test(tenant.id, req);

    assert.equal(result.success, false);
    assert.equal(result.diagnostics.metadataFetch, "fail");
    assert.match(result.errorMessage ?? "", /Could not fetch IdP metadata/);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres + real local mock OIDC provider: OIDC test connection passes metadataFetch/certificateValidation/groupMapping against a real discovery document", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const ssoConfigRepository = new SsoConfigRepository();
  const idpMetadataService = new IdpMetadataService();
  const kms = new InMemoryKmsService();
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), new InMemoryAuditService());
  const controller = new SsoTestController(pool, ssoConfigRepository, idpMetadataService, encryptionService, new PostgresAuditService(pool));
  const provider = await startMockOidcProvider();

  try {
    const tenant = await provisionTenant(pool, slug, kms);
    const encryptedSecret = await encryptionService.encrypt(tenant.id, Buffer.from(provider.clientSecret, "utf8"));
    await ssoConfigRepository.upsert(pool, {
      tenantId: tenant.id,
      protocol: "oidc",
      oidcDiscoveryUrl: `${provider.issuerUrl}/.well-known/openid-configuration`,
      oidcClientId: provider.clientId,
      oidcClientSecret: encryptedSecret,
    });
    await pool.query("INSERT INTO group_role_mappings (tenant_id, idp_group, platform_role, priority) VALUES ($1, 'clinicians', 'compliance_officer', 0)", [tenant.id]);

    const req = { tenantId: tenant.id, actorId: null } as any;
    const result = await controller.test(tenant.id, req);

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.diagnostics.metadataFetch, "pass");
    assert.equal(result.diagnostics.certificateValidation, "pass");
    assert.equal(result.diagnostics.assertionParsing, "pass");
    assert.equal(result.diagnostics.groupMapping, "pass");
  } finally {
    await provider.close();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
