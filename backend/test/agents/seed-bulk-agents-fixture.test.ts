import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentInFlightOperationsService } from "../../src/agents/agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "../../src/agents/agent-state-transitions.repository";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { LifecycleService } from "../../src/agents/lifecycle.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { seedBulkAgents } from "../fixtures/agents/seed-bulk-agents";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const skip = !DATABASE_URL || !REDIS_URL;

function randomSlug(): string {
  return `test-bulk-seed-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_state_transitions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("seedBulkAgents produces 54 real agents across 3 teams in a mix of lifecycle states", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const inFlightOperations = new AgentInFlightOperationsService();
  const pubsub = new RedisPubSubService();

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const service = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
    const lifecycleService = new LifecycleService(agentsRepository, new AgentStateTransitionsRepository(pool), audit, inFlightOperations, pubsub);

    const tenant = await saga.provision({ name: "Bulk Seed Fixture Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const { teamIds, agentIds } = await seedBulkAgents(pool, service, lifecycleService, tenant.id);

    assert.equal(teamIds.length, 3);
    assert.equal(agentIds.length, 54);

    const rows = await pool.query("SELECT lifecycle_status, team_id FROM agents WHERE tenant_id = $1", [tenant.id]);
    assert.equal(rows.rows.length, 54, "at least 50 agents required for bulk operation testing");
    assert.ok(new Set(rows.rows.map((r) => r.team_id)).size === 3, "all 3 teams must have agents");

    const statuses = new Set(rows.rows.map((r) => r.lifecycle_status));
    for (const expected of ["connecting", "active", "paused", "retired", "decommissioned"]) {
      assert.ok(statuses.has(expected), `expected at least one agent in status "${expected}"`);
    }
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
    await inFlightOperations.onModuleDestroy();
    await pubsub.onModuleDestroy();
  }
});
