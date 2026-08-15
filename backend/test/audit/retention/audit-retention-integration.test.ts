import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AuditStoreRepository } from "../../../src/audit/audit-store.repository";
import { AuditLogQueryRepository } from "../../../src/audit/query/audit-log-query.repository";
import { AuditLogQueryService } from "../../../src/audit/query/audit-log-query.service";
import { ColdStorageManifestRepository } from "../../../src/audit/retention/cold-storage-manifest.repository";
import { ColdStorageTieringService } from "../../../src/audit/retention/cold-storage-tiering.service";
import { LocalFilesystemColdStorageService } from "../../../src/audit/retention/local-filesystem-cold-storage.service";
import { RetentionPolicyRepository } from "../../../src/audit/retention/retention-policy.repository";
import { RetentionPolicyService } from "../../../src/audit/retention/retention-policy.service";
import { RetentionPurgeService } from "../../../src/audit/retention/retention-purge.service";
import { PermissionName } from "../../../src/rbac/rbac.constants";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-retention-${Math.random().toString(36).slice(2, 10)}`;
}

function amsAppPool(): Pool {
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  return new Pool({ connectionString: appUrl.toString() });
}

// A random, unused historical year_month keeps each test run's partition
// name collision-free against other concurrent test runs and past runs'
// leftover partitions, without needing anything other than the fixed
// audit_events_YYYY_MM naming convention itself.
function randomYearMonth(): { year: number; month: number } {
  // Bounded well clear of the 90-day tiering threshold in either
  // direction (never within the last couple of years, never in the
  // future) so every generated partition is unambiguously eligible.
  const maxYear = new Date().getUTCFullYear() - 2;
  return { year: 1950 + Math.floor(Math.random() * (maxYear - 1950)), month: 1 + Math.floor(Math.random() * 12) };
}

async function withTenantContext<T = any>(pool: Pool, tenantId: string, fn: (client: any) => Promise<T>): Promise<T> {
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

async function cleanupTenant(adminPool: Pool, slug: string): Promise<void> {
  const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM retention_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenant(adminPool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const audit = new PostgresAuditService(adminPool);
  const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
  return saga.provision({ name: `Retention ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
}

/** Creates a real audit_events partition for [start, end) via the admin (superuser) connection — the same DDL migration 005's own create_audit_events_partitions() performs, just for an arbitrary historical month this test controls directly. */
async function createPartition(adminPool: Pool, partitionName: string, start: Date, end: Date): Promise<void> {
  await adminPool.query(`CREATE TABLE ${partitionName} PARTITION OF audit_events FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`);
}

async function dropPartitionIfExists(adminPool: Pool, partitionName: string): Promise<void> {
  await adminPool.query(`ALTER TABLE audit_events DETACH PARTITION ${partitionName}`).catch(() => undefined);
  await adminPool.query(`DROP TABLE IF EXISTS ${partitionName}`).catch(() => undefined);
}

test("cold storage tiering: archives an old partition to a local NDJSON file, verifies its checksum, drops the live partition, and records a manifest entry + audit event", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const { year, month } = randomYearMonth();
  const partitionName = `audit_events_${year}_${String(month).padStart(2, "0")}`;
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));

  try {
    const tenant = await provisionTenant(adminPool, slug);
    await createPartition(adminPool, partitionName, periodStart, periodEnd);

    const storeRepository = new AuditStoreRepository(appPool);
    await withTenantContext(appPool, tenant.id, async (client) => {
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "old.event.one", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: { n: 1 } }, client, new Date(periodStart.getTime() + 1000));
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "old.event.two", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: { n: 2 } }, client, new Date(periodStart.getTime() + 2000));
    });

    const coldStorage = new LocalFilesystemColdStorageService();
    const manifestRepository = new ColdStorageManifestRepository(appPool);
    const auditService = new PostgresAuditService(appPool);
    const tiering = new ColdStorageTieringService(appPool, coldStorage, manifestRepository, auditService);

    const results = await tiering.runDailyTiering();
    const thisResult = results.find((r) => r.partitionName === partitionName);
    assert.ok(thisResult, "the newly created old partition must be picked up by this run");
    assert.equal(thisResult!.status, "tiered");
    assert.equal(thisResult!.rowCount, 2);

    // The live partition must be gone from Postgres.
    const stillExists = await adminPool.query("SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'audit_events' AND c.relname = $1", [partitionName]);
    assert.equal(stillExists.rows.length, 0);

    // A manifest row must exist, and the archive must genuinely contain both rows.
    const manifest = await manifestRepository.findByPartitionName(partitionName);
    assert.ok(manifest);
    assert.equal(manifest!.rowCount, 2);
    const verified = await coldStorage.verifyChecksum(manifest!.storageKey, manifest!.checksum);
    assert.equal(verified, true);

    const archivedRows: any[] = [];
    for await (const row of coldStorage.readArchive(manifest!.storageKey)) archivedRows.push(row);
    assert.equal(archivedRows.length, 2);
    assert.deepEqual(
      archivedRows.map((r) => r.action).sort(),
      ["old.event.one", "old.event.two"],
    );

    // A retention.partition_tiered audit event must have been recorded for the tenant.
    const tieringEvent: any = await withTenantContext(appPool, tenant.id, (client) => client.query("SELECT * FROM audit_events WHERE tenant_id = $1 AND action = 'retention.partition_tiered'", [tenant.id]));
    assert.equal(tieringEvent.rows.length, 1);
    assert.equal(tieringEvent.rows[0].details.rowCount, 2);

    await coldStorage.deleteArchive(manifest!.storageKey);
  } finally {
    await dropPartitionIfExists(adminPool, partitionName);
    await adminPool.query("DELETE FROM cold_storage_manifest WHERE partition_name = $1", [partitionName]);
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("cold storage tiering: a partition with zero rows across all tenants is dropped with no manifest entry created", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const { year, month } = randomYearMonth();
  const partitionName = `audit_events_${year}_${String(month).padStart(2, "0")}`;
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));

  try {
    await createPartition(adminPool, partitionName, periodStart, periodEnd);

    const coldStorage = new LocalFilesystemColdStorageService();
    const manifestRepository = new ColdStorageManifestRepository(appPool);
    const auditService = new PostgresAuditService(appPool);
    const tiering = new ColdStorageTieringService(appPool, coldStorage, manifestRepository, auditService);

    const results = await tiering.runDailyTiering();
    const thisResult = results.find((r) => r.partitionName === partitionName);
    assert.ok(thisResult);
    assert.equal(thisResult!.status, "empty_skipped");
    assert.equal(thisResult!.rowCount, 0);

    const manifest = await manifestRepository.findByPartitionName(partitionName);
    assert.equal(manifest, null);

    const stillExists = await adminPool.query("SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'audit_events' AND c.relname = $1", [partitionName]);
    assert.equal(stillExists.rows.length, 0);
  } finally {
    await dropPartitionIfExists(adminPool, partitionName);
    await adminPool.end();
    await appPool.end();
  }
});

test("retention purge: a cold-tiered archive far enough in the past that even the 7-year default has elapsed is purged and its audit event recorded", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const partitionName = `audit_events_2010_${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}`;
  const month = Number(partitionName.slice(-2));
  const periodStart = new Date(Date.UTC(2010, month - 1, 1));
  const periodEnd = new Date(Date.UTC(2010, month, 1)); // ~16 years ago — past even the 2555-day (7yr) default

  try {
    const tenant = await provisionTenant(adminPool, slug);

    const coldStorage = new LocalFilesystemColdStorageService();
    const manifestRepository = new ColdStorageManifestRepository(appPool);
    const auditService = new PostgresAuditService(appPool);

    async function* rows() {
      yield { id: "11111111-1111-1111-1111-111111111111", tenant_id: tenant.id, actor_id: null, action: "ancient.event", resource_type: "test_resource", resource_id: null, data_classification: "internal", details: {}, occurred_at: new Date(periodStart.getTime() + 1000).toISOString(), prev_hash: null, record_hash: "deadbeef" };
    }
    const uploaded = await coldStorage.uploadPartitionArchive(partitionName, rows());
    await manifestRepository.create({ partitionName, dataCategory: "audit_logs", periodStart, periodEnd, storageKey: uploaded.storageKey, checksum: uploaded.checksum, rowCount: uploaded.rowCount });

    const retentionPolicyRepository = new RetentionPolicyRepository(appPool);
    const retentionPolicyService = new RetentionPolicyService(retentionPolicyRepository, auditService);
    const purge = new RetentionPurgeService(appPool, coldStorage, manifestRepository, retentionPolicyRepository, retentionPolicyService, auditService);

    const results = await purge.runDailyPurge();
    const thisResult = results.find((r) => r.partitionName === partitionName);
    assert.ok(thisResult);
    assert.equal(thisResult!.status, "purged");
    assert.equal(thisResult!.rowsPurged, 1);

    const manifest = await manifestRepository.findByPartitionName(partitionName);
    assert.ok(manifest!.purgedAt);

    const exists = await (async () => {
      try {
        for await (const _ of coldStorage.readArchive(uploaded.storageKey)) return true;
        return false;
      } catch {
        return false;
      }
    })();
    assert.equal(exists, false, "the archive file itself must be deleted");

    const purgeEvent: any = await withTenantContext(appPool, tenant.id, (client) => client.query("SELECT * FROM audit_events WHERE tenant_id = $1 AND action = 'retention.data_purged'", [tenant.id]));
    assert.equal(purgeEvent.rows.length, 1);
    assert.equal(purgeEvent.rows[0].details.rowCount, 1);
  } finally {
    // The manifest row is purposely left in place by RetentionPurgeService
    // itself (purged_at set, not deleted — the immutable "this existed,
    // was archived, was purged" record). Removed here only for this
    // test's own hygiene so repeated runs never accumulate rows.
    await adminPool.query("DELETE FROM cold_storage_manifest WHERE partition_name = $1", [partitionName]);
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("retention purge: an archive whose period hasn't cleared the retention window yet is left untouched", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const partitionName = `audit_events_${new Date().getUTCFullYear() - 1}_${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}`;
  const periodEnd = new Date(); // "now" — nowhere near any category's retention window having elapsed

  try {
    const coldStorage = new LocalFilesystemColdStorageService();
    const manifestRepository = new ColdStorageManifestRepository(appPool);
    const auditService = new PostgresAuditService(appPool);

    async function* rows() {
      yield { id: "22222222-2222-2222-2222-222222222222", tenant_id: "33333333-3333-3333-3333-333333333333", actor_id: null, action: "recent.event", resource_type: "test_resource", resource_id: null, data_classification: "internal", details: {}, occurred_at: new Date().toISOString(), prev_hash: null, record_hash: "cafebabe" };
    }
    const uploaded = await coldStorage.uploadPartitionArchive(partitionName, rows());
    await manifestRepository.create({ partitionName, dataCategory: "audit_logs", periodStart: new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000), periodEnd, storageKey: uploaded.storageKey, checksum: uploaded.checksum, rowCount: uploaded.rowCount });

    const retentionPolicyRepository = new RetentionPolicyRepository(appPool);
    const retentionPolicyService = new RetentionPolicyService(retentionPolicyRepository, auditService);
    const purge = new RetentionPurgeService(appPool, coldStorage, manifestRepository, retentionPolicyRepository, retentionPolicyService, auditService);

    const results = await purge.runDailyPurge();
    const thisResult = results.find((r) => r.partitionName === partitionName);
    assert.ok(thisResult);
    assert.equal(thisResult!.status, "not_yet_eligible");

    const manifest = await manifestRepository.findByPartitionName(partitionName);
    assert.equal(manifest!.purgedAt, null);
    await coldStorage.deleteArchive(uploaded.storageKey);
  } finally {
    await adminPool.query("DELETE FROM cold_storage_manifest WHERE partition_name = $1", [partitionName]);
    await adminPool.end();
    await appPool.end();
  }
});

test("query federation: GET /audit/logs with cold_storage=true merges a tiered archive's matching rows with live hot-storage results", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const { year, month } = randomYearMonth();
  const partitionName = `audit_events_${year}_${String(month).padStart(2, "0")}`;
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));

  try {
    const tenant = await provisionTenant(adminPool, slug);
    await createPartition(adminPool, partitionName, periodStart, periodEnd);

    const storeRepository = new AuditStoreRepository(appPool);
    await withTenantContext(appPool, tenant.id, async (client) => {
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "cold.match", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client, new Date(periodStart.getTime() + 1000));
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "cold.no_match", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client, new Date(periodStart.getTime() + 2000));
    });

    const coldStorage = new LocalFilesystemColdStorageService();
    const manifestRepository = new ColdStorageManifestRepository(appPool);
    const auditService = new PostgresAuditService(appPool);
    const tiering = new ColdStorageTieringService(appPool, coldStorage, manifestRepository, auditService);
    await tiering.runDailyTiering();

    const queryRepository = new AuditLogQueryRepository(appPool);
    const queryService = new AuditLogQueryService(appPool, queryRepository, coldStorage, manifestRepository);

    const result = await queryService.query(
      { tenantId: tenant.id, actorId: "irrelevant", permissions: [PermissionName.AUDIT_LOGS_VIEW_ORG] },
      { startTime: periodStart.toISOString(), endTime: periodEnd.toISOString(), action: "cold.match", cold_storage: true } as any,
    );

    assert.equal(result.coldStorageQueried, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].action, "cold.match");

    // Without cold_storage=true, the same query sees nothing (the partition has been physically dropped from hot storage).
    const hotOnly = await queryService.query(
      { tenantId: tenant.id, actorId: "irrelevant", permissions: [PermissionName.AUDIT_LOGS_VIEW_ORG] },
      { startTime: periodStart.toISOString(), endTime: periodEnd.toISOString(), action: "cold.match" } as any,
    );
    assert.equal(hotOnly.coldStorageQueried, false);
    assert.equal(hotOnly.entries.length, 0);
  } finally {
    await dropPartitionIfExists(adminPool, partitionName);
    const manifest = await adminPool.query("SELECT storage_key FROM cold_storage_manifest WHERE partition_name = $1", [partitionName]);
    if (manifest.rows.length > 0) {
      await new LocalFilesystemColdStorageService().deleteArchive(manifest.rows[0].storage_key);
      await adminPool.query("DELETE FROM cold_storage_manifest WHERE partition_name = $1", [partitionName]);
    }
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
