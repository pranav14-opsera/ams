import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { TeamMembershipRepository } from "../../src/rbac/team-membership.repository";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-team-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM team_members WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("getUserTeamIds returns exactly the teams a user belongs to within their own tenant", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Team Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const userId = randomUUID();
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)", [userId, tenant.id, "lead@example.com", "Team Lead"]);

    const teamA = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team A') RETURNING id", [tenant.id]);
    const teamB = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team B') RETURNING id", [tenant.id]);
    await pool.query("INSERT INTO team_members (team_id, user_id, tenant_id, role) VALUES ($1, $2, $3, 'lead')", [teamA.rows[0].id, userId, tenant.id]);

    const repository = new TeamMembershipRepository(pool);
    const teamIds = await repository.getUserTeamIds(tenant.id, userId);

    assert.deepEqual(teamIds, [teamA.rows[0].id]);
    assert.ok(!teamIds.includes(teamB.rows[0].id));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("getUserTeamIds returns an empty array for a user who belongs to no team", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "No Team Co", slug, dataResidencyRegion: "us", actorId: null });

    const userId = randomUUID();
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)", [userId, tenant.id, "solo@example.com", "Solo User"]);

    const repository = new TeamMembershipRepository(pool);
    assert.deepEqual(await repository.getUserTeamIds(tenant.id, userId), []);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
