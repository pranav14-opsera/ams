import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ScimGroupService } from "../../src/scim/scim-group.service";
import { GroupRoleMappingRepository } from "../../src/auth/provisioning/group-role-mapping.repository";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-scimgrp-${Math.random().toString(36).slice(2, 10)}`;
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
  const groupRoleMappingRepository = new GroupRoleMappingRepository();
  const scimGroupService = new ScimGroupService(pool, groupRoleMappingRepository, audit);
  return { saga, scimGroupService, groupRoleMappingRepository };
}

async function insertUser(pool: Pool, tenantId: string, email: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)", [id, tenantId, email, "Test User"]);
  return id;
}

test("create makes a SCIM Group that IS a group_role_mapping row, carrying the platformRole extension", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimGroupService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Group Create Co", slug, dataResidencyRegion: "us", actorId: null });

    const group = await scimGroupService.create(pool, tenant.id, null, {
      displayName: "clinicians",
      "urn:ietf:params:scim:schemas:extension:ams:2.0:Group": { platformRole: "agent_operator", priority: 50 },
    });

    assert.equal(group.displayName, "clinicians");
    assert.equal(group["urn:ietf:params:scim:schemas:extension:ams:2.0:Group"].platformRole, "agent_operator");
    assert.deepEqual(group.members, []);

    const row = await pool.query("SELECT idp_group, platform_role, priority FROM group_role_mappings WHERE id = $1", [group.id]);
    assert.equal(row.rows[0].idp_group, "clinicians");
    assert.equal(row.rows[0].platform_role, "agent_operator");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("create rejects a payload missing the platformRole extension attribute", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimGroupService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Group No Role Co", slug, dataResidencyRegion: "us", actorId: null });
    await assert.rejects(
      () => scimGroupService.create(pool, tenant.id, null, { displayName: "no-role-group" }),
      (err: any) => {
        assert.equal(err.getStatus(), 400);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("PATCH add member assigns the group's mapped role to that user", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimGroupService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Group Add Co", slug, dataResidencyRegion: "us", actorId: null });
    const userId = await insertUser(pool, tenant.id, "member@example.com");
    const group = await scimGroupService.create(pool, tenant.id, null, {
      displayName: "finance-team",
      "urn:ietf:params:scim:schemas:extension:ams:2.0:Group": { platformRole: "finance_manager", priority: 100 },
    });

    const updated = await scimGroupService.patchMembers(pool, tenant.id, null, group.id, [{ op: "add", path: "members", value: [{ value: userId }] }]);
    assert.equal(updated.members.length, 1);
    assert.equal(updated.members[0].value, userId);

    const userRow = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
    assert.equal(userRow.rows[0].role, "finance_manager");

    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'scim.user_role_reassigned'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("PATCH remove member re-resolves role to null (deny-by-default) once no group grants one", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimGroupService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Group Remove Co", slug, dataResidencyRegion: "us", actorId: null });
    const userId = await insertUser(pool, tenant.id, "leaving-group@example.com");
    const group = await scimGroupService.create(pool, tenant.id, null, {
      displayName: "compliance-team",
      "urn:ietf:params:scim:schemas:extension:ams:2.0:Group": { platformRole: "compliance_officer", priority: 100 },
    });
    await scimGroupService.patchMembers(pool, tenant.id, null, group.id, [{ op: "add", path: "members", value: [{ value: userId }] }]);

    await scimGroupService.patchMembers(pool, tenant.id, null, group.id, [{ op: "remove", path: "members", value: [{ value: userId }] }]);

    const userRow = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
    assert.equal(userRow.rows[0].role, null);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a user in TWO groups gets the lowest-priority-value mapping's role", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimGroupService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Group Priority Co", slug, dataResidencyRegion: "us", actorId: null });
    const userId = await insertUser(pool, tenant.id, "multi-group@example.com");

    const staffGroup = await scimGroupService.create(pool, tenant.id, null, {
      displayName: "staff",
      "urn:ietf:params:scim:schemas:extension:ams:2.0:Group": { platformRole: "agent_operator", priority: 100 },
    });
    const adminGroup = await scimGroupService.create(pool, tenant.id, null, {
      displayName: "admins",
      "urn:ietf:params:scim:schemas:extension:ams:2.0:Group": { platformRole: "platform_admin", priority: 5 },
    });

    await scimGroupService.patchMembers(pool, tenant.id, null, staffGroup.id, [{ op: "add", path: "members", value: [{ value: userId }] }]);
    await scimGroupService.patchMembers(pool, tenant.id, null, adminGroup.id, [{ op: "add", path: "members", value: [{ value: userId }] }]);

    const userRow = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
    assert.equal(userRow.rows[0].role, "platform_admin");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("get returns 404 for an unknown group id", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimGroupService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Group 404 Co", slug, dataResidencyRegion: "us", actorId: null });
    await assert.rejects(
      () => scimGroupService.get(pool, tenant.id, "00000000-0000-0000-0000-000000000099"),
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

test("list returns every group for the tenant with its member list", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, scimGroupService } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "SCIM Group List Co", slug, dataResidencyRegion: "us", actorId: null });
    await scimGroupService.create(pool, tenant.id, null, { displayName: "group-a", "urn:ietf:params:scim:schemas:extension:ams:2.0:Group": { platformRole: "team_lead", priority: 100 } });
    await scimGroupService.create(pool, tenant.id, null, { displayName: "group-b", "urn:ietf:params:scim:schemas:extension:ams:2.0:Group": { platformRole: "agent_operator", priority: 100 } });

    const result = await scimGroupService.list(pool, tenant.id);
    assert.equal(result.totalResults, 2);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
