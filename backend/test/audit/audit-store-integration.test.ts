import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { AuditStoreRepository } from "../../src/audit/audit-store.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-audit-${Math.random().toString(36).slice(2, 10)}`;
}

/** ams_app is the least-privilege role every real application code path connects as — the same technique tenant-provisioning.saga.ams-app.test.ts established. Testing append-only enforcement against the superuser connection would silently pass for the wrong reason (superusers bypass privilege checks entirely). */
function amsAppPool(): Pool {
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  return new Pool({ connectionString: appUrl.toString() });
}

async function provisionTenant(adminPool: Pool, slug: string): Promise<string> {
  const kms = new InMemoryKmsService();
  const audit = new PostgresAuditService(adminPool);
  const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
  const tenant = await saga.provision({ name: `Audit Test ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  return tenant.id;
}

async function cleanupTenant(adminPool: Pool, slug: string): Promise<void> {
  const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

/** audit_events' RLS policy requires app.current_tenant to be set (an unset context raises a real error, not a silent no-match — same as every other RLS-protected table in this codebase). Mirrors TenantContextMiddleware's own BEGIN/set_config/COMMIT shape for a real request. */
async function withTenantContext<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

test("insertAuditEvent writes a real row, chaining record_hash from the previous event for that tenant", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  try {
    const tenantId = await provisionTenant(adminPool, slug);
    const repository = new AuditStoreRepository(appPool);

    const { first, second } = await withTenantContext(appPool, tenantId, async (client) => {
      const first = await repository.insertAuditEvent(
        { tenantId, actorId: null, action: "test.action.one", resourceType: "test_resource", resourceId: "11111111-1111-1111-1111-111111111111", details: { step: 1 } },
        client,
      );
      const second = await repository.insertAuditEvent(
        { tenantId, actorId: null, action: "test.action.two", resourceType: "test_resource", resourceId: "11111111-1111-1111-1111-111111111111", details: { step: 2 } },
        client,
        new Date(first.occurredAt.getTime() + 1000),
      );
      return { first, second };
    });

    assert.ok(first.recordHash.length === 64, "record_hash must be a 64-char hex SHA-256 digest");
    assert.notEqual(first.recordHash, second.recordHash);

    const rawSecond = await adminPool.query("SELECT prev_hash FROM audit_events WHERE id = $1", [second.id]);
    assert.equal(rawSecond.rows[0].prev_hash, first.recordHash, "the second event's prev_hash must equal the first event's record_hash");

    const lastHash = await withTenantContext(appPool, tenantId, (client) => repository.getLastHash(tenantId, client));
    assert.equal(lastHash, second.recordHash);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("verifyChain reports valid:true for an untampered chain", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  try {
    const tenantId = await provisionTenant(adminPool, slug);
    const repository = new AuditStoreRepository(appPool);

    // Anchored to "now" (not a hardcoded past date) so these inserts always
    // land within whatever partition window actually exists — migration
    // 005 only creates partitions forward from whenever it was applied.
    const base = new Date();
    await withTenantContext(appPool, tenantId, async (client) => {
      for (let i = 0; i < 10; i++) {
        await repository.insertAuditEvent(
          { tenantId, actorId: null, action: `test.action.${i}`, resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: { i } },
          client,
          new Date(base.getTime() + i * 1000),
        );
      }
    });

    const verification = await withTenantContext(appPool, tenantId, (client) =>
      repository.verifyChain(tenantId, new Date(base.getTime() - 60_000), new Date(base.getTime() + 60_000), client),
    );
    assert.equal(verification.valid, true);
    assert.equal(verification.firstBrokenId, null);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("verifyChain detects tampering — a row whose content was altered after the fact no longer matches its stored record_hash", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  try {
    const tenantId = await provisionTenant(adminPool, slug);
    const repository = new AuditStoreRepository(appPool);

    const base = new Date();
    const events = await withTenantContext(appPool, tenantId, async (client) => {
      const inserted = [];
      for (let i = 0; i < 5; i++) {
        inserted.push(
          await repository.insertAuditEvent(
            { tenantId, actorId: null, action: `test.action.${i}`, resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: { i } },
            client,
            new Date(base.getTime() + i * 1000),
          ),
        );
      }
      return inserted;
    });

    // Simulate tampering directly at the storage layer — application code
    // can never do this (UPDATE is revoked for ams_app), but a genuine
    // tamper-evidence mechanism must detect it even if the DATABASE itself
    // were compromised by an admin with superuser access.
    const tamperedId = events[2].id;
    await adminPool.query("UPDATE audit_events SET details = '{\"i\": 999}'::jsonb WHERE id = $1", [tamperedId]);

    const verification = await withTenantContext(appPool, tenantId, (client) =>
      repository.verifyChain(tenantId, new Date(base.getTime() - 60_000), new Date(base.getTime() + 60_000), client),
    );
    assert.equal(verification.valid, false);
    assert.equal(verification.firstBrokenId, tamperedId);
    assert.match(verification.detail, /record_hash does not match/);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("verifyChain seeds from the record immediately before the window, so a mid-chain window still verifies correctly", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  try {
    const tenantId = await provisionTenant(adminPool, slug);
    const repository = new AuditStoreRepository(appPool);

    const base = new Date();
    await withTenantContext(appPool, tenantId, async (client) => {
      for (let i = 0; i < 6; i++) {
        await repository.insertAuditEvent(
          { tenantId, actorId: null, action: `test.action.${i}`, resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: { i } },
          client,
          new Date(base.getTime() + i * 1000),
        );
      }
    });

    // A window starting AFTER the first 3 events — must still validate
    // correctly against the real prior link, not assume a genesis start.
    const verification = await withTenantContext(appPool, tenantId, (client) =>
      repository.verifyChain(tenantId, new Date(base.getTime() + 3000 - 500), new Date(base.getTime() + 10_000), client),
    );
    assert.equal(verification.valid, true);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("append-only: ams_app (the role every application code path connects as) cannot UPDATE audit_events", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  try {
    const tenantId = await provisionTenant(adminPool, slug);
    const repository = new AuditStoreRepository(appPool);
    const inserted = await withTenantContext(appPool, tenantId, (client) =>
      repository.insertAuditEvent({ tenantId, actorId: null, action: "test.action", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client),
    );
    const freshPool = amsAppPool();
    try {
      await assert.rejects(() => freshPool.query("UPDATE audit_events SET action = 'tampered' WHERE id = $1::uuid", [inserted.id]), /permission denied/i);
    } finally {
      await freshPool.end();
    }
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("append-only: ams_app cannot DELETE audit_events", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  try {
    const tenantId = await provisionTenant(adminPool, slug);
    const repository = new AuditStoreRepository(appPool);
    const inserted = await withTenantContext(appPool, tenantId, (client) =>
      repository.insertAuditEvent({ tenantId, actorId: null, action: "test.action", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client),
    );

    const freshPool = amsAppPool();
    try {
      await assert.rejects(() => freshPool.query("DELETE FROM audit_events WHERE id = $1::uuid", [inserted.id]), /permission denied/i);
    } finally {
      await freshPool.end();
    }
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("RLS: a tenant-scoped session can never read another tenant's audit events (adversarial cross-tenant check)", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slugA = randomSlug();
  const slugB = randomSlug();
  try {
    const tenantAId = await provisionTenant(adminPool, slugA);
    const tenantBId = await provisionTenant(adminPool, slugB);
    const repository = new AuditStoreRepository(appPool);

    await withTenantContext(appPool, tenantAId, (client) =>
      repository.insertAuditEvent({ tenantId: tenantAId, actorId: null, action: "tenant.a.action", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client),
    );
    await withTenantContext(appPool, tenantBId, (client) =>
      repository.insertAuditEvent({ tenantId: tenantBId, actorId: null, action: "tenant.b.action", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client),
    );

    const rows = await withTenantContext(appPool, tenantAId, (client) => client.query("SELECT action FROM audit_events WHERE tenant_id = $1", [tenantBId]));

    assert.equal(rows.rows.length, 0, "a session scoped to tenant A must never see tenant B's audit events, even querying tenant B's id directly");
  } finally {
    await cleanupTenant(adminPool, slugA);
    await cleanupTenant(adminPool, slugB);
    await adminPool.end();
    await appPool.end();
  }
});

test("partition routing: events land in the correct monthly partition table based on occurred_at", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  try {
    const tenantId = await provisionTenant(adminPool, slug);
    const repository = new AuditStoreRepository(appPool);

    // 2 months out from "now" — comfortably inside the 12-month-ahead
    // window migration 005 creates from whenever it was applied, without
    // hardcoding a specific calendar month that could fall outside that
    // window in a later run.
    const occurredAt = new Date();
    occurredAt.setUTCMonth(occurredAt.getUTCMonth() + 2, 15);
    const expectedPartition = `audit_events_${occurredAt.getUTCFullYear()}_${String(occurredAt.getUTCMonth() + 1).padStart(2, "0")}`;

    const inserted = await withTenantContext(appPool, tenantId, (client) =>
      repository.insertAuditEvent({ tenantId, actorId: null, action: "test.partition.routing", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client, occurredAt),
    );

    const partitionCheck = await adminPool.query(`SELECT tableoid::regclass::text AS partition_name FROM audit_events WHERE id = $1`, [inserted.id]);
    assert.equal(partitionCheck.rows[0].partition_name, expectedPartition);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
