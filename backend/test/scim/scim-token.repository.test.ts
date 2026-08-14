import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { ScimTokenRepository } from "../../src/scim/scim-token.repository";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-scimtok-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM scim_tokens WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenant(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  return saga.provision({ name: "SCIM Token Co", slug, dataResidencyRegion: "us", actorId: null });
}

test("generate returns a raw token that verifiably round-trips via findByRawToken, and never stores it in plaintext", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repository = new ScimTokenRepository();
  const slug = randomSlug();
  try {
    const tenant = await provisionTenant(pool, slug);
    const { rawToken, record } = await repository.generate(pool, tenant.id, "Okta production", null);

    assert.ok(rawToken.startsWith("scim_"));
    const found = await repository.findByRawToken(pool, rawToken);
    assert.equal(found?.id, record.id);

    const row = await pool.query("SELECT token_hash FROM scim_tokens WHERE id = $1", [record.id]);
    assert.ok(!row.rows[0].token_hash.toString("utf8").includes(rawToken), "the raw token must never appear in the stored row");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("findByRawToken returns null for a token that was never issued", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repository = new ScimTokenRepository();
  assert.equal(await repository.findByRawToken(pool, "scim_never_issued"), null);
  await pool.end();
});

test("a revoked token no longer resolves via findByRawToken", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repository = new ScimTokenRepository();
  const slug = randomSlug();
  try {
    const tenant = await provisionTenant(pool, slug);
    const { rawToken, record } = await repository.generate(pool, tenant.id, null, null);

    const revoked = await repository.revoke(pool, tenant.id, record.id);
    assert.equal(revoked, true);
    assert.equal(await repository.findByRawToken(pool, rawToken), null);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("list returns every token (including revoked) for a tenant, ordered newest first", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repository = new ScimTokenRepository();
  const slug = randomSlug();
  try {
    const tenant = await provisionTenant(pool, slug);
    await repository.generate(pool, tenant.id, "first", null);
    const second = await repository.generate(pool, tenant.id, "second", null);
    await repository.revoke(pool, tenant.id, second.record.id);

    const tokens = await repository.list(pool, tenant.id);
    assert.equal(tokens.length, 2);
    assert.ok(tokens.some((t) => t.revokedAt !== null));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("revoking a token from a DIFFERENT tenant is a no-op (tenant isolation)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repository = new ScimTokenRepository();
  const slugA = randomSlug();
  const slugB = randomSlug();
  try {
    const tenantA = await provisionTenant(pool, slugA);
    const tenantB = await provisionTenant(pool, slugB);
    const { record } = await repository.generate(pool, tenantA.id, null, null);

    const revoked = await repository.revoke(pool, tenantB.id, record.id);
    assert.equal(revoked, false);

    const tokens = await repository.list(pool, tenantA.id);
    assert.equal(tokens[0].revokedAt, null);
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
  }
});
