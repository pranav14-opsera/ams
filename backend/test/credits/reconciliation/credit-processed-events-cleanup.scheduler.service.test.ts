import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { CreditProcessedEventRepository } from "../../../src/credits/reconciliation/credit-processed-event.repository";
import { CreditProcessedEventsCleanupSchedulerService } from "../../../src/credits/reconciliation/credit-processed-events-cleanup.scheduler.service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-cleanup-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_processed_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("real Postgres: the cleanup scheduler purges events older than 7 days but leaves recent ones untouched", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new CreditProcessedEventRepository(pool);
  const scheduler = new CreditProcessedEventsCleanupSchedulerService(repository);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Cleanup Tenant", slug, dataResidencyRegion: "us", actorId: null });

    const oldEventId = "11111111-1111-1111-1111-111111111111";
    const recentEventId = "22222222-2222-2222-2222-222222222222";
    await pool.query("INSERT INTO credit_processed_events (event_id, tenant_id, processed_at) VALUES ($1, $2, now() - interval '10 days')", [oldEventId, tenant.id]);
    await pool.query("INSERT INTO credit_processed_events (event_id, tenant_id, processed_at) VALUES ($1, $2, now() - interval '1 day')", [recentEventId, tenant.id]);

    const purged = await scheduler.runCleanup();
    assert.equal(purged, 1);

    const remaining = await pool.query("SELECT event_id FROM credit_processed_events WHERE tenant_id = $1", [tenant.id]);
    assert.equal(remaining.rows.length, 1);
    assert.equal(remaining.rows[0].event_id, recentEventId);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
