import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { TenantProvisioningSaga, TenantAlreadyExistsError, TenantProvisioningError } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import type { RbacServicePort } from "../../src/tenants/ports/rbac-service.port";

// Real PostgreSQL, not a mock — no Docker/testcontainers available in this
// environment (documented throughout this repo's other WOs), so this
// connects directly to a local Postgres the same way
// database/tests/test_rls_isolation.sh does. Requires DATABASE_URL to
// point at a database with this repo's migrations already applied.
const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-tenant-${Math.random().toString(36).slice(2, 10)}`;
}

// audit_events references tenants ON DELETE RESTRICT — deliberately, so
// an audit trail can never be cascade-deleted along with the tenant that
// generated it (database/migrations/005_create_audit_events.sql). Test
// cleanup has to respect that same ordering a real tenant offboarding
// would.
async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("saga happy path: provisions tenant, key, RBAC rows, and an audit event", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);

  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Test Co", slug, dataResidencyRegion: "us", actorId: null });

    assert.equal(tenant.slug, slug);
    assert.equal(tenant.isActive, true);
    assert.ok(tenant.encryptionKeyArn);
    assert.ok(kms.createdKeys.has(tenant.encryptionKeyArn!));

    const rbacRows = await pool.query("SELECT role FROM rbac_policies WHERE tenant_id = $1", [tenant.id]);
    assert.equal(rbacRows.rows.length, 5);

    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
    assert.equal(auditRows.rows[0].action, "tenant.provisioned");

    const tenantRow = await pool.query("SELECT status FROM tenants WHERE id = $1", [tenant.id]);
    assert.equal(tenantRow.rows[0].status, "active");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("saga rejects a duplicate slug without creating a second row", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);

  const slug = randomSlug();
  try {
    await saga.provision({ name: "First", slug, dataResidencyRegion: "us", actorId: null });

    await assert.rejects(() => saga.provision({ name: "Second", slug, dataResidencyRegion: "us", actorId: null }), TenantAlreadyExistsError);

    const rows = await pool.query("SELECT count(*)::int AS n FROM tenants WHERE slug = $1", [slug]);
    assert.equal(rows.rows[0].n, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("saga rolls back the DB transaction AND compensates the KMS key when a later step fails", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const failingRbac: RbacServicePort = {
    applyDefaultPolicies: async () => {
      throw new Error("simulated RBAC service outage");
    },
    getPermissionsForRoles: async () => [],
  };
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, failingRbac, audit);

  const slug = randomSlug();
  await assert.rejects(() => saga.provision({ name: "Rollback Co", slug, dataResidencyRegion: "us", actorId: null }), TenantProvisioningError);

  // DB rolled back — no tenant row at all.
  const tenantRows = await pool.query("SELECT count(*)::int AS n FROM tenants WHERE slug = $1", [slug]);
  assert.equal(tenantRows.rows[0].n, 0);

  // The KMS key WAS created (before the failing step) and then compensated.
  assert.equal(kms.createdKeys.size, 0);

  await pool.end();
});

test("saga does not call KMS at all if tenant creation itself fails (duplicate slug)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);

  const slug = randomSlug();
  try {
    await saga.provision({ name: "First", slug, dataResidencyRegion: "us", actorId: null });
    const keysAfterFirst = kms.createdKeys.size;

    await assert.rejects(() => saga.provision({ name: "Second", slug, dataResidencyRegion: "us", actorId: null }));

    assert.equal(kms.createdKeys.size, keysAfterFirst, "no additional KMS key should have been created for the rejected duplicate");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
