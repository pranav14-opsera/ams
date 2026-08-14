import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { JitProvisioningService } from "../../../src/auth/provisioning/jit-provisioning.service";
import { GroupRoleMappingRepository } from "../../../src/auth/provisioning/group-role-mapping.repository";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-jit-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM group_role_mappings WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const tenantRepo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, tenantRepo, keyMetadataRepo, kms, rbac, audit);
  const groupRoleMappingRepository = new GroupRoleMappingRepository();
  const jit = new JitProvisioningService(pool, groupRoleMappingRepository, audit);
  return { saga, jit, groupRoleMappingRepository, audit };
}

test("a brand-new IdP subject with a mapped group is auto-created with the resolved platform role", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit, groupRoleMappingRepository } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT Create Co", slug, dataResidencyRegion: "us", actorId: null });
    await groupRoleMappingRepository.upsert(pool, tenant.id, "org-admins", "platform_admin", 10);

    const result = await jit.provisionOrUpdate(tenant.id, "idp-subject-1", "new-user@example.com", "New User", ["org-admins"]);

    assert.equal(result.role, "platform_admin");
    const row = await pool.query("SELECT provisioned_via, role, idp_subject FROM users WHERE id = $1", [result.userId]);
    assert.equal(row.rows[0].provisioned_via, "jit");
    assert.equal(row.rows[0].role, "platform_admin");
    assert.equal(row.rows[0].idp_subject, "idp-subject-1");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("when a user belongs to multiple mapped groups, the lowest-priority-value mapping wins", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit, groupRoleMappingRepository } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT Priority Co", slug, dataResidencyRegion: "us", actorId: null });
    await groupRoleMappingRepository.upsert(pool, tenant.id, "staff", "agent_operator", 100);
    await groupRoleMappingRepository.upsert(pool, tenant.id, "admins", "platform_admin", 5);

    const result = await jit.provisionOrUpdate(tenant.id, "idp-subject-2", "multi-group@example.com", null, ["staff", "admins"]);

    assert.equal(result.role, "platform_admin", "priority 5 must outrank priority 100 regardless of array order");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a user's role is re-resolved and updated when their group mapping changes on a subsequent login", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit, groupRoleMappingRepository } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT Role Change Co", slug, dataResidencyRegion: "us", actorId: null });
    await groupRoleMappingRepository.upsert(pool, tenant.id, "team-leads", "team_lead", 100);

    const first = await jit.provisionOrUpdate(tenant.id, "idp-subject-3", "promoted@example.com", null, ["team-leads"]);
    assert.equal(first.role, "team_lead");

    await groupRoleMappingRepository.upsert(pool, tenant.id, "finance", "finance_manager", 100);
    const second = await jit.provisionOrUpdate(tenant.id, "idp-subject-3", "promoted@example.com", null, ["finance"]);

    assert.equal(second.role, "finance_manager");
    assert.equal(second.userId, first.userId, "must be the SAME user row, just with an updated role");

    const row = await pool.query("SELECT role FROM users WHERE id = $1", [first.userId]);
    assert.equal(row.rows[0].role, "finance_manager");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("an idp_subject already linked to an existing user re-resolves role without re-matching by email", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit, groupRoleMappingRepository } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT Subject Match Co", slug, dataResidencyRegion: "us", actorId: null });
    await groupRoleMappingRepository.upsert(pool, tenant.id, "clinicians", "agent_operator", 100);
    const first = await jit.provisionOrUpdate(tenant.id, "idp-subject-4", "linked@example.com", null, ["clinicians"]);

    // Re-login with the SAME idp_subject but a changed email upstream —
    // must still match by idp_subject, not attempt (and fail) an email match.
    const second = await jit.provisionOrUpdate(tenant.id, "idp-subject-4", "linked-changed-email@example.com", null, ["clinicians"]);
    assert.equal(second.userId, first.userId);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a group with no matching mapping resolves to a NULL role (deny-by-default) and records an audit event", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT No Mapping Co", slug, dataResidencyRegion: "us", actorId: null });
    const result = await jit.provisionOrUpdate(tenant.id, "idp-subject-5", "unmapped@example.com", null, ["nonexistent-group"]);

    assert.equal(result.role, null);
    const auditRows = await pool.query("SELECT details FROM audit_events WHERE tenant_id = $1 AND action = 'auth.jit.no_role_matched'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
    assert.deepEqual(auditRows.rows[0].details.groups, ["nonexistent-group"]);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a user deactivated via SCIM is NOT reactivated by a JIT/SSO login — ForbiddenException instead", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT SCIM Guard Co", slug, dataResidencyRegion: "us", actorId: null });
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO users (id, tenant_id, email, display_name, idp_subject, status, provisioned_via) VALUES ($1, $2, $3, $4, $5, 'deactivated', 'scim')",
      [userId, tenant.id, "deprovisioned@example.com", "Deprovisioned User", "idp-subject-6"],
    );

    await assert.rejects(
      () => jit.provisionOrUpdate(tenant.id, "idp-subject-6", "deprovisioned@example.com", null, []),
      (err: any) => {
        assert.equal(err.getStatus(), 403);
        return true;
      },
    );

    const row = await pool.query("SELECT status FROM users WHERE id = $1", [userId]);
    assert.equal(row.rows[0].status, "deactivated", "must remain deactivated, not silently reactivated");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a manually-provisioned, active user matched by email is linked to idp_subject and gets a resolved role like any other JIT match", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit, groupRoleMappingRepository } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT Manual Match Co", slug, dataResidencyRegion: "us", actorId: null });
    await groupRoleMappingRepository.upsert(pool, tenant.id, "compliance", "compliance_officer", 100);
    const userId = randomUUID();
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)", [userId, tenant.id, "pre-provisioned@example.com", "Pre Provisioned"]);

    const result = await jit.provisionOrUpdate(tenant.id, "idp-subject-7", "pre-provisioned@example.com", null, ["compliance"]);

    assert.equal(result.userId, userId);
    assert.equal(result.role, "compliance_officer");
    const row = await pool.query("SELECT idp_subject, provisioned_via FROM users WHERE id = $1", [userId]);
    assert.equal(row.rows[0].idp_subject, "idp-subject-7", "idp_subject must be backfilled");
    assert.equal(row.rows[0].provisioned_via, "manual", "linking an existing manual user must NOT overwrite how it was originally provisioned");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("provisioning without an email for a brand-new subject is rejected — an identity anchor is required to create a user", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, jit } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "JIT No Email Co", slug, dataResidencyRegion: "us", actorId: null });
    await assert.rejects(
      () => jit.provisionOrUpdate(tenant.id, "idp-subject-8", null, null, []),
      (err: any) => {
        assert.equal(err.getStatus(), 403);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
