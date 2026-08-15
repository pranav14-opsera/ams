import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { seedAgents } from "../fixtures/agents/seed-agents";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(suffix: string): string {
  return `test-agents-seed-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("seedAgents produces 12 real agents across 2 tenants, 3 teams, all 4 frameworks, and 3 lifecycle statuses", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugA = randomSlug("a");
  const slugB = randomSlug("b");

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const service = new AgentsService(pool, new AgentsRepository(pool), encryptionService, audit);

    const tenantA = await saga.provision({ name: "Seed Fixture Tenant A", slug: slugA, dataResidencyRegion: "us", actorId: null });
    const tenantB = await saga.provision({ name: "Seed Fixture Tenant B", slug: slugB, dataResidencyRegion: "us", actorId: null });

    const { teamIds } = await seedAgents(pool, service, tenantA.id, tenantB.id);
    assert.equal(teamIds.length, 3);

    const tenantARows = await pool.query("SELECT framework, lifecycle_status, team_id FROM agents WHERE tenant_id = $1", [tenantA.id]);
    const tenantBRows = await pool.query("SELECT framework FROM agents WHERE tenant_id = $1", [tenantB.id]);

    assert.equal(tenantARows.rows.length, 9);
    assert.equal(tenantBRows.rows.length, 3);
    assert.equal(tenantARows.rows.length + tenantBRows.rows.length, 12, "at least 10 agent records across 2 tenants");

    assert.deepEqual(new Set(tenantARows.rows.map((r) => r.framework)), new Set(["langchain", "crewai", "autogen", "generic_rest"]), "all 4 framework types must be represented");
    assert.ok(new Set(tenantARows.rows.map((r) => r.lifecycle_status)).size >= 3, "multiple lifecycle statuses must be represented");
    assert.deepEqual(new Set(tenantARows.rows.map((r) => r.team_id)), new Set(teamIds), "all 3 teams must have at least one agent");
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
  }
});
