import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PlatformRoleName } from "../../src/rbac/rbac.constants";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TeamsRepository } from "../../src/teams/teams.repository";
import { TeamsService } from "../../src/teams/teams.service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-teams-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM team_members WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenant(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const audit = new PostgresAuditService(pool);
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), audit);
  return saga.provision({ name: `Teams Test ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
}

test("list returns every tenant team with a member count for an org-scoped caller", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const tenant = await provisionTenant(pool, slug);
    const teamA = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team A') RETURNING id", [tenant.id])).rows[0].id;
    await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team B')", [tenant.id]);

    const userId = randomUUID();
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, 'member@example.com', 'Member')", [userId, tenant.id]);
    await pool.query("INSERT INTO team_members (team_id, tenant_id, user_id) VALUES ($1, $2, $3)", [teamA, tenant.id, userId]);

    const service = new TeamsService(new TeamsRepository(pool), new PostgresAuditService(pool));
    const teams = await service.list(pool, { tenantId: tenant.id, actorId: null, roles: [PlatformRoleName.PLATFORM_ADMIN] });

    assert.equal(teams.length, 2);
    const a = teams.find((t) => t.id === teamA);
    assert.equal(a?.memberCount, 1);
    const b = teams.find((t) => t.name === "Team B");
    assert.equal(b?.memberCount, 0);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("list restricts a team-scoped caller to only their own teams", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const tenant = await provisionTenant(pool, slug);
    const teamA = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team A') RETURNING id", [tenant.id])).rows[0].id;
    await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team B')", [tenant.id]);

    const userId = randomUUID();
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, 'lead@example.com', 'Lead')", [userId, tenant.id]);
    await pool.query("INSERT INTO team_members (team_id, tenant_id, user_id) VALUES ($1, $2, $3)", [teamA, tenant.id, userId]);

    const service = new TeamsService(new TeamsRepository(pool), new PostgresAuditService(pool));
    const teams = await service.list(pool, { tenantId: tenant.id, actorId: userId, roles: [PlatformRoleName.TEAM_LEAD] });

    assert.equal(teams.length, 1);
    assert.equal(teams[0].id, teamA);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("create adds a new team and records an audit event; duplicate name is a 409", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const tenant = await provisionTenant(pool, slug);
    const service = new TeamsService(new TeamsRepository(pool), new PostgresAuditService(pool));

    const created = await service.create(pool, { tenantId: tenant.id, actorId: null, roles: [PlatformRoleName.PLATFORM_ADMIN] }, "New Team");
    assert.equal(created.name, "New Team");
    assert.equal(created.memberCount, 0);

    const audit = await pool.query("SELECT action, resource_id FROM audit_events WHERE tenant_id = $1 AND action = 'team.created'", [tenant.id]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].resource_id, created.id);

    await assert.rejects(() => service.create(pool, { tenantId: tenant.id, actorId: null, roles: [PlatformRoleName.PLATFORM_ADMIN] }, "New Team"), /already exists/);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
