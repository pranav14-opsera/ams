import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { ScimTestController } from "../../src/scim/scim-test.controller";
import { ScimTokenRepository } from "../../src/scim/scim-token.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-scim-test-${Math.random().toString(36).slice(2, 8)}`;
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
  return saga.provision({ name: "SCIM Test Tenant", slug, dataResidencyRegion: "us", actorId: null });
}

test("real Postgres: SCIM test provisioning fails tokenActive when no bearer token has been generated yet, then passes once one exists", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const tokenRepository = new ScimTokenRepository();
  const controller = new ScimTestController(pool, tokenRepository, new PostgresAuditService(pool));

  try {
    const tenant = await provisionTenant(pool, slug);
    const req = { tenantId: tenant.id, actorId: null } as any;

    const before = await controller.test(tenant.id, req);
    assert.equal(before.success, false);
    assert.equal(before.diagnostics.tokenActive, "fail");
    assert.match(before.errorMessage ?? "", /No active SCIM bearer token/);

    await tokenRepository.generate(pool, tenant.id, "Onboarding token", null);
    const after = await controller.test(tenant.id, req);
    assert.equal(after.success, true, JSON.stringify(after));
    assert.equal(after.diagnostics.tokenActive, "pass");
    assert.equal(after.diagnostics.filterParsing, "pass");

    const auditRows = await pool.query("SELECT * FROM audit_events WHERE tenant_id = $1 AND action = 'scim.test_provisioning'", [tenant.id]);
    assert.equal(auditRows.rows.length, 2);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: a revoked-only token still fails tokenActive", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const tokenRepository = new ScimTokenRepository();
  const controller = new ScimTestController(pool, tokenRepository, new PostgresAuditService(pool));

  try {
    const tenant = await provisionTenant(pool, slug);
    const { record } = await tokenRepository.generate(pool, tenant.id, "Revoked token", null);
    await tokenRepository.revoke(pool, tenant.id, record.id);

    const req = { tenantId: tenant.id, actorId: null } as any;
    const result = await controller.test(tenant.id, req);
    assert.equal(result.diagnostics.tokenActive, "fail");
    assert.equal(result.success, false);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
