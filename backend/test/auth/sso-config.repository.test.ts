import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { SsoConfigRepository } from "../../src/auth/sso-config.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-sso-config-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenant_sso_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("upsert creates a config, and a second upsert increments version and replaces protocol-specific fields", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const ssoConfigRepository = new SsoConfigRepository();

  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SSO Config Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const first = await ssoConfigRepository.upsert(pool, {
      tenantId: tenant.id,
      protocol: "saml",
      samlMetadataUrl: "https://idp-v1.example.com/metadata",
      samlEntityId: "ams-platform",
    });
    assert.equal(first.version, 1);
    assert.equal(first.protocol, "saml");

    // Switching protocol entirely — SAML fields must not linger.
    const second = await ssoConfigRepository.upsert(pool, {
      tenantId: tenant.id,
      protocol: "oidc",
      oidcDiscoveryUrl: "https://idp-v2.example.com/.well-known/openid-configuration",
      oidcClientId: "client-2",
    });
    assert.equal(second.version, 2, "version must increment on reconfiguration");
    assert.equal(second.protocol, "oidc");
    assert.equal(second.samlMetadataUrl, null, "stale SAML fields must be cleared when switching to OIDC");
    assert.equal(second.samlEntityId, null);

    const fetched = await ssoConfigRepository.findByTenantId(pool, tenant.id);
    assert.equal(fetched?.oidcClientId, "client-2");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("findByTenantId returns null for a tenant with no SSO config", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repo = new SsoConfigRepository();
  const result = await repo.findByTenantId(pool, "00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
  await pool.end();
});
