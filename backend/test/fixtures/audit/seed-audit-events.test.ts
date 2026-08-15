import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AuditStoreRepository } from "../../../src/audit/audit-store.repository";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { seedAuditEventFixtures } from "./seed-audit-events";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-audit-fixture-${Math.random().toString(36).slice(2, 10)}`;
}

function amsAppPool(): Pool {
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  return new Pool({ connectionString: appUrl.toString() });
}

async function cleanupTenants(adminPool: Pool, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
    if (tenant.rows.length === 0) continue;
    const tenantId = tenant.rows[0].id;
    await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
    await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
    await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
}

test("seedAuditEventFixtures produces at least 1,000 real, hash-chained audit events across 3 tenants and 3 monthly partitions", { skip, timeout: 60_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slugs = [randomSlug(), randomSlug(), randomSlug()];

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);

    const tenantIds: string[] = [];
    for (const slug of slugs) {
      const tenant = await saga.provision({ name: `Audit Fixture ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
      tenantIds.push(tenant.id);
    }

    const { insertedCount, monthsUsed } = await seedAuditEventFixtures(appPool, tenantIds, 1000);

    assert.ok(insertedCount >= 1000, `expected at least 1000 events, got ${insertedCount}`);
    assert.equal(monthsUsed.length, 3);
    assert.equal(new Set(monthsUsed).size, 3, "must span 3 DISTINCT months");

    const totalRows = await adminPool.query("SELECT count(*)::int AS c FROM audit_events WHERE tenant_id = ANY($1) AND (details->>'fixture')::boolean = true", [tenantIds]);
    assert.equal(totalRows.rows[0].c, insertedCount);

    const partitionsUsed = await adminPool.query(
      `SELECT DISTINCT tableoid::regclass::text AS partition_name FROM audit_events WHERE tenant_id = ANY($1) AND (details->>'fixture')::boolean = true`,
      [tenantIds],
    );
    assert.equal(partitionsUsed.rows.length, 3, "fixture events must land in exactly 3 distinct partitions");

    const repository = new AuditStoreRepository(appPool);
    for (const tenantId of tenantIds) {
      const client = await appPool.connect();
      let verification;
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        verification = await repository.verifyChain(tenantId, new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), new Date(Date.now() + 200 * 24 * 60 * 60 * 1000), client);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assert.equal(verification.valid, true, `tenant ${tenantId}'s fixture-generated chain must be genuinely valid`);
    }
  } finally {
    await cleanupTenants(adminPool, slugs);
    await adminPool.end();
    await appPool.end();
  }
});
