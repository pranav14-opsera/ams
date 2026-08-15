import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AuditLogQueryRepository } from "../../../src/audit/query/audit-log-query.repository";
import { AuditStoreRepository } from "../../../src/audit/audit-store.repository";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-audit-query-${Math.random().toString(36).slice(2, 10)}`;
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

async function withTenantContext<T>(pool: Pool, tenantId: string, fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

test("findByFilters returns entries within the time range, ordered newest-first, and paginates via keyset cursor", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Query ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const storeRepository = new AuditStoreRepository(appPool);
    const queryRepository = new AuditLogQueryRepository(appPool);

    const base = new Date();
    const insertedIds: string[] = [];
    await withTenantContext(appPool, tenant.id, async (client) => {
      for (let i = 0; i < 25; i++) {
        const inserted = await storeRepository.insertAuditEvent(
          { tenantId: tenant.id, actorId: null, action: `test.action.${i % 3}`, resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: { i } },
          client,
          new Date(base.getTime() + i * 1000),
        );
        insertedIds.push(inserted.id);
      }
    });

    const startTime = new Date(base.getTime() - 60_000);
    const endTime = new Date(base.getTime() + 60_000);

    const page1 = await withTenantContext(appPool, tenant.id, (client) => queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, resourceType: "test_resource" }, 10, null, client));
    assert.equal(page1.entries.length, 10);
    assert.ok(page1.nextCursor);
    // Newest-first: the first entry in page 1 must be the LAST inserted event (i=24).
    assert.equal(page1.entries[0].id, insertedIds[24]);

    const page2 = await withTenantContext(appPool, tenant.id, (client) => queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, resourceType: "test_resource" }, 10, page1.nextCursor, client));
    assert.equal(page2.entries.length, 10);
    assert.ok(page2.nextCursor);
    assert.equal(page2.entries[0].id, insertedIds[14]);

    const page3 = await withTenantContext(appPool, tenant.id, (client) => queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, resourceType: "test_resource" }, 10, page2.nextCursor, client));
    assert.equal(page3.entries.length, 5, "the last page must have exactly the remainder");
    assert.equal(page3.nextCursor, null, "no next cursor once every row has been returned");

    // No overlap and no gaps across pages.
    const allIds = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.id);
    assert.equal(new Set(allIds).size, 25);
    assert.deepEqual(allIds.sort(), [...insertedIds].sort());
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("findByFilters honors action/resourceType/dataClassification/correlationId filters", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Query Filters ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const storeRepository = new AuditStoreRepository(appPool);
    const queryRepository = new AuditLogQueryRepository(appPool);
    const base = new Date();

    await withTenantContext(appPool, tenant.id, async (client) => {
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "user.login", resourceType: "session", resourceId: "00000000-0000-0000-0000-000000000000", details: { correlation_id: "corr-A" }, dataClassification: "internal" as any }, client, base);
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "data.exported", resourceType: "export_job", resourceId: "00000000-0000-0000-0000-000000000000", details: { correlation_id: "corr-B" }, dataClassification: "confidential" as any }, client, new Date(base.getTime() + 1000));
    });

    const startTime = new Date(base.getTime() - 60_000);
    const endTime = new Date(base.getTime() + 60_000);

    const byAction = await withTenantContext(appPool, tenant.id, (client) => queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, action: "user.login" }, 10, null, client));
    assert.equal(byAction.entries.length, 1);
    assert.equal(byAction.entries[0].action, "user.login");

    const byResourceType = await withTenantContext(appPool, tenant.id, (client) => queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, resourceType: "export_job" }, 10, null, client));
    assert.equal(byResourceType.entries.length, 1);

    const byClassification = await withTenantContext(appPool, tenant.id, (client) => queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, dataClassification: "confidential" }, 10, null, client));
    assert.equal(byClassification.entries.length, 1);
    assert.equal(byClassification.entries[0].action, "data.exported");

    const byCorrelation = await withTenantContext(appPool, tenant.id, (client) => queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, correlationId: "corr-A" }, 10, null, client));
    assert.equal(byCorrelation.entries.length, 1);
    assert.equal(byCorrelation.entries[0].action, "user.login");
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("findByFilters with restrictToActorIds never returns events from actors outside that set (team-scoping mechanism)", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Query Team Scope ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const storeRepository = new AuditStoreRepository(appPool);
    const queryRepository = new AuditLogQueryRepository(appPool);
    const base = new Date();

    const inTeamActorId = "11111111-1111-1111-1111-111111111111";

    await withTenantContext(appPool, tenant.id, async (client) => {
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "actor.in.team", resourceType: "x", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client, base);
    });

    const startTime = new Date(base.getTime() - 60_000);
    const endTime = new Date(base.getTime() + 60_000);
    const restricted = await withTenantContext(appPool, tenant.id, (client) =>
      queryRepository.findByFilters({ tenantId: tenant.id, startTime, endTime, restrictToActorIds: [inTeamActorId] }, 10, null, client),
    );
    // The one inserted event has actor_id NULL (system actor), which is
    // never in ANY restrictToActorIds set — confirms the restriction is
    // a real SQL filter, not a no-op.
    assert.equal(restricted.entries.length, 0);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
