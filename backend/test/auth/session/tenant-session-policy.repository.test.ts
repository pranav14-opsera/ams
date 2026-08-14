import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { TenantSessionPolicyRepository } from "../../../src/auth/session/tenant-session-policy.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-session-policy-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenant_session_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("findByTenantId returns null for a tenant with no configured policy", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const policyRepo = new TenantSessionPolicyRepository();
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Session Policy Test Co", slug, dataResidencyRegion: "us", actorId: null });
    assert.equal(await policyRepo.findByTenantId(pool, tenant.id), null);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("upsert creates then updates a tenant's session policy idempotently (same row, not a duplicate)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const policyRepo = new TenantSessionPolicyRepository();
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Session Policy Test Co 2", slug, dataResidencyRegion: "us", actorId: null });

    const first = await policyRepo.upsert(pool, tenant.id, 900, 14400);
    assert.equal(first.idleTimeoutSeconds, 900);
    assert.equal(first.absoluteTimeoutSeconds, 14400);

    const second = await policyRepo.upsert(pool, tenant.id, 1200, 21600);
    assert.equal(second.idleTimeoutSeconds, 1200);

    const rows = await pool.query("SELECT count(*)::int AS n FROM tenant_session_policies WHERE tenant_id = $1", [tenant.id]);
    assert.equal(rows.rows[0].n, 1, "upsert must update the existing row, not insert a second one");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("the CHECK constraints reject out-of-range timeouts at the database layer too, not just the DTO", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const policyRepo = new TenantSessionPolicyRepository();
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Session Policy Test Co 3", slug, dataResidencyRegion: "us", actorId: null });
    await assert.rejects(() => policyRepo.upsert(pool, tenant.id, 10, 14400)); // below the 300s CHECK floor
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
