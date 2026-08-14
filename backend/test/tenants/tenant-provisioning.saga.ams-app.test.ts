import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";

// Real bug found while implementing WO-015: the saga's own tests
// (tenant-provisioning.saga.test.ts) all connect via DATABASE_URL as-is,
// which in local dev and this backend-checks.yml CI job is the postgres
// SUPERUSER — a role that bypasses RLS entirely regardless of FORCE ROW
// LEVEL SECURITY. That silently masked a real defect: the saga never set
// app.current_tenant for the tenant it had just created, so every INSERT
// into an RLS-enforced table (rbac_policies, tenant_key_metadata) it makes
// AFTER that point would be rejected outright when run as ams_app — the
// least-privilege role production actually connects as (see
// common/database/database.module.ts's own comment). This test connects
// as ams_app explicitly (same technique as
// tenants/tenant-rls-integration.test.ts: swap DATABASE_URL's username)
// specifically so this class of bug can never hide behind a superuser
// connection again.
const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-ams-app-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(adminPool: Pool, slug: string): Promise<void> {
  const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("saga provisions a tenant successfully when its DB pool connects as ams_app, not the superuser", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  const appPool = new Pool({ connectionString: appUrl.toString() });

  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(appPool);
  const rbac = new PostgresRbacService(appPool);
  const saga = new TenantProvisioningSaga(appPool, repo, keyMetadataRepo, kms, rbac, audit);

  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "AMS App Co", slug, dataResidencyRegion: "us", actorId: null });

    assert.equal(tenant.slug, slug);
    assert.ok(tenant.encryptionKeyArn);

    // Read back as the superuser (ground truth, bypasses RLS) to confirm
    // the rows genuinely exist — not just that the saga didn't throw.
    const rbacRows = await adminPool.query("SELECT role FROM rbac_policies WHERE tenant_id = $1", [tenant.id]);
    assert.equal(rbacRows.rows.length, 5, "all 5 default RBAC policies must have actually been inserted");

    const keyMetadataRows = await adminPool.query("SELECT key_arn, current_version FROM tenant_key_metadata WHERE tenant_id = $1", [tenant.id]);
    assert.equal(keyMetadataRows.rows.length, 1);
    assert.equal(keyMetadataRows.rows[0].key_arn, tenant.encryptionKeyArn);
    assert.equal(keyMetadataRows.rows[0].current_version, 1);

    const auditRows = await adminPool.query("SELECT action FROM audit_events WHERE tenant_id = $1", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
