import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { ScimUserService } from "../../src/scim/scim-user.service";
import { SessionService } from "../../src/auth/session/session.service";
import { InMemorySessionStore } from "../../src/auth/session/in-memory-session-store.service";
import { InMemoryRefreshTokenStore } from "../../src/auth/token/in-memory-refresh-token-store.service";
import { TenantSessionPolicyRepository } from "../../src/auth/session/tenant-session-policy.repository";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-scim-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM scim_group_memberships WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM group_role_mappings WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const refreshTokenStore = new InMemoryRefreshTokenStore();
  const sessionStore = new InMemorySessionStore();
  const sessionService = new SessionService(pool, sessionStore, refreshTokenStore, new TenantSessionPolicyRepository(), audit);
  const scimUserService = new ScimUserService(sessionService, audit);
  return { saga, scimUserService, sessionService, sessionStore, refreshTokenStore, audit };
}

test("create provisions a new user via SCIM with provisioned_via='scim'", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Create Co", slug, dataResidencyRegion: "us", actorId: null });

    const resource = await scimUserService.create(pool, tenant.id, null, { userName: "new.hire@example.com", displayName: "New Hire", active: true });

    assert.equal(resource.userName, "new.hire@example.com");
    assert.equal(resource.active, true);
    assert.ok(resource.id);

    const row = await pool.query("SELECT provisioned_via, status FROM users WHERE id = $1", [resource.id]);
    assert.equal(row.rows[0].provisioned_via, "scim");
    assert.equal(row.rows[0].status, "active");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("create rejects a duplicate userName with 409", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Dup Co", slug, dataResidencyRegion: "us", actorId: null });
    await scimUserService.create(pool, tenant.id, null, { userName: "dup@example.com", active: true });

    await assert.rejects(
      () => scimUserService.create(pool, tenant.id, null, { userName: "dup@example.com", active: true }),
      (err: any) => {
        assert.equal(err.getStatus(), 409);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("create with active:false provisions an already-deactivated user", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Inactive Create Co", slug, dataResidencyRegion: "us", actorId: null });
    const resource = await scimUserService.create(pool, tenant.id, null, { userName: "preinactive@example.com", active: false });
    assert.equal(resource.active, false);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("list returns paginated results with totalResults/itemsPerPage/startIndex", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM List Co", slug, dataResidencyRegion: "us", actorId: null });
    for (let i = 0; i < 5; i++) {
      await scimUserService.create(pool, tenant.id, null, { userName: `user${i}@example.com`, active: true });
    }

    const page1 = await scimUserService.list(pool, tenant.id, undefined, 1, 2);
    assert.equal(page1.totalResults, 5);
    assert.equal(page1.itemsPerPage, 2);
    assert.equal(page1.startIndex, 1);
    assert.equal(page1.Resources.length, 2);

    const page2 = await scimUserService.list(pool, tenant.id, undefined, 3, 2);
    assert.equal(page2.Resources.length, 2);
    assert.notDeepEqual(page1.Resources.map((r) => r.id), page2.Resources.map((r) => r.id));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("list supports filtering by userName eq", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Filter Co", slug, dataResidencyRegion: "us", actorId: null });
    await scimUserService.create(pool, tenant.id, null, { userName: "findme@example.com", active: true });
    await scimUserService.create(pool, tenant.id, null, { userName: "notme@example.com", active: true });

    const result = await scimUserService.list(pool, tenant.id, `userName eq "findme@example.com"`, 1, 100);
    assert.equal(result.totalResults, 1);
    assert.equal(result.Resources[0].userName, "findme@example.com");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("get returns 404 for an unknown user id", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM 404 Co", slug, dataResidencyRegion: "us", actorId: null });
    await assert.rejects(
      () => scimUserService.get(pool, tenant.id, "00000000-0000-0000-0000-000000000099"),
      (err: any) => {
        assert.equal(err.getStatus(), 404);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("PATCH active:false deactivates the user and invalidates all their sessions/refresh tokens", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService, sessionService, sessionStore, refreshTokenStore } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Deactivate Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await scimUserService.create(pool, tenant.id, null, { userName: "tobefired@example.com", active: true });

    const session = await sessionService.createSession(created.id, tenant.id, "fp");
    await refreshTokenStore.store("rt-1", { userId: created.id, tenantId: tenant.id, deviceFingerprint: "fp", roles: [], sessionId: session.sessionId }, 28800);

    const patched = await scimUserService.patch(pool, tenant.id, null, created.id, [{ op: "replace", path: "active", value: false }]);
    assert.equal(patched.active, false);

    assert.equal(await sessionStore.get(session.sessionId), null);
    assert.equal(await refreshTokenStore.consumeAndInvalidate("rt-1"), null);

    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'scim.user_deactivated'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("PATCH honors Entra ID's capitalized 'Replace' op with a whole-object value (no path)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Entra Patch Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await scimUserService.create(pool, tenant.id, null, { userName: "entra.user@example.com", active: true });

    const patched = await scimUserService.patch(pool, tenant.id, null, created.id, [{ op: "Replace" as any, value: { active: false } }]);
    assert.equal(patched.active, false);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("PATCH reactivating a user (active:false -> true) does NOT re-invalidate sessions (no side effect on reactivation)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Reactivate Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await scimUserService.create(pool, tenant.id, null, { userName: "rehire@example.com", active: false });

    const reactivated = await scimUserService.patch(pool, tenant.id, null, created.id, [{ op: "replace", path: "active", value: true }]);
    assert.equal(reactivated.active, true);

    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'scim.user_deactivated'", [tenant.id]);
    assert.equal(auditRows.rows.length, 0);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("PUT replaces displayName/email/active in a single call", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Put Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await scimUserService.create(pool, tenant.id, null, { userName: "original@example.com", displayName: "Original Name", active: true });

    const replaced = await scimUserService.replace(pool, tenant.id, null, created.id, { userName: "renamed@example.com", displayName: "Renamed Person", active: true });
    assert.equal(replaced.userName, "renamed@example.com");
    assert.equal(replaced.displayName, "Renamed Person");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("DELETE soft-deactivates rather than removing the row, and invalidates sessions", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimUserService, sessionService, sessionStore } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Delete Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await scimUserService.create(pool, tenant.id, null, { userName: "leaver@example.com", active: true });
    const session = await sessionService.createSession(created.id, tenant.id, "fp");

    await scimUserService.deactivate(pool, tenant.id, null, created.id);

    const row = await pool.query("SELECT status FROM users WHERE id = $1", [created.id]);
    assert.equal(row.rows.length, 1, "the row must still exist");
    assert.equal(row.rows[0].status, "deactivated");
    assert.equal(await sessionStore.get(session.sessionId), null);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
