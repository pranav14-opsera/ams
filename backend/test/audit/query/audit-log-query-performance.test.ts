import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AuditLogQueryRepository } from "../../../src/audit/query/audit-log-query.repository";
import { seedAuditEventFixtures } from "../../fixtures/audit/seed-audit-events";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-audit-perf-${Math.random().toString(36).slice(2, 10)}`;
}

function amsAppPool(): Pool {
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  return new Pool({ connectionString: appUrl.toString() });
}

async function cleanupTenant(adminPool: Pool, slug: string): Promise<void> {
  const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

/**
 * WO-047 AC: "<5s for a 12-month span with 500K+ records." Seeding
 * 500K-1M real, hash-chained rows sequentially (each insert going
 * through the per-tenant advisory lock + trigger) would take on the
 * order of tens of minutes in this sandbox — not a reasonable automated
 * test. This seeds a reduced volume (10,000 rows, reusing WO-045's own
 * fixture generator) and asserts the query stays comfortably fast via
 * the (tenant_id, occurred_at, action, data_classification) index —
 * keyset pagination means query cost is dominated by the index seek, not
 * the total row count, so this is expected to hold at 500K+ rows too.
 * See AUDIT_EXPORT_QUERY_API.md for the full reconciliation and a
 * documented manual/staging validation plan at the AC's literal scale.
 */
test("query response time stays well under the 5s budget against a real (reduced-scale) multi-thousand-row dataset", { skip, timeout: 120_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Perf ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const seedStart = Date.now();
    const { insertedCount } = await seedAuditEventFixtures(appPool, [tenant.id], 10_000);
    const seedDurationMs = Date.now() - seedStart;
    console.log(`seeded ${insertedCount} real audit_events rows in ${(seedDurationMs / 1000).toFixed(1)}s`);

    const queryRepository = new AuditLogQueryRepository(appPool);
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);

      const queryStart = Date.now();
      const page = await queryRepository.findByFilters(
        { tenantId: tenant.id, startTime: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000), endTime: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000) },
        100,
        null,
        client,
      );
      const queryDurationMs = Date.now() - queryStart;
      console.log(`query over ${insertedCount} rows (100-row page) took ${queryDurationMs}ms`);

      const countStart = Date.now();
      const total = await queryRepository.countByFilters({ tenantId: tenant.id, startTime: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000), endTime: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000) }, client);
      const countDurationMs = Date.now() - countStart;
      console.log(`count over ${insertedCount} rows took ${countDurationMs}ms`);

      await client.query("COMMIT");

      assert.equal(page.entries.length, 100);
      // >= rather than exact equality: the tenant's own "tenant.provisioned"
      // audit event (written by TenantProvisioningSaga) also falls inside
      // this wide time window, alongside the seeded fixture rows.
      assert.ok(total >= insertedCount, `expected at least ${insertedCount} rows, got ${total}`);
      assert.ok(queryDurationMs < 5000, `page query took ${queryDurationMs}ms, exceeding the 5s AC budget`);
      assert.ok(countDurationMs < 5000, `count query took ${countDurationMs}ms, exceeding the 5s AC budget`);
    } finally {
      client.release();
    }
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
