import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentInFlightOperationsService } from "../../src/agents/agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "../../src/agents/agent-state-transitions.repository";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { BulkLifecycleService } from "../../src/agents/bulk-lifecycle.service";
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
  return `test-bulk-lifecycle-${Math.random().toString(36).slice(2, 8)}`;
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

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit);
  const transitionsRepository = new AgentStateTransitionsRepository(pool);
  const inFlightOperations = new AgentInFlightOperationsService();
  const pubsub = new RedisPubSubService();
  const lifecycleService = new LifecycleService(agentsRepository, transitionsRepository, audit, inFlightOperations, pubsub);
  const bulkLifecycleService = new BulkLifecycleService(agentsRepository, lifecycleService);
  return { saga, agentsService, lifecycleService, bulkLifecycleService, transitionsRepository, inFlightOperations, pubsub };
}

test("bulk pause of 50 agents with mixed valid/invalid current states: per-agent DB state and audit records match the response summary", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, agentsService, lifecycleService, bulkLifecycleService, inFlightOperations, pubsub } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Bulk Lifecycle Flow Co", slug, dataResidencyRegion: "us", actorId: null });
    const actorId = (await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, 'bulk-actor@example.com', 'Bulk Actor') RETURNING id", [tenant.id])).rows[0].id;

    const { agentIds } = await seedBulkAgents(pool, agentsService, lifecycleService, tenant.id);
    const targetSubset = agentIds.slice(0, 50);

    // Ground truth: which of these 50 are actually Active right now (only
    // Active->Paused is a valid transition — everything else must fail).
    const before = await pool.query<{ id: string; lifecycle_status: string }>("SELECT id, lifecycle_status FROM agents WHERE id = ANY($1::uuid[])", [targetSubset]);
    const expectedSuccessIds = new Set(before.rows.filter((r) => r.lifecycle_status === "active").map((r) => r.id));
    const expectedFailureIds = new Set(before.rows.filter((r) => r.lifecycle_status !== "active").map((r) => r.id));
    assert.ok(expectedSuccessIds.size > 0 && expectedFailureIds.size > 0, "the fixture must produce a genuine mix for this test to mean anything");

    const result = await bulkLifecycleService.execute(pool, tenant.id, actorId, { agentIds: targetSubset, targetStatus: "paused" as any });

    assert.equal(result.totalCount, 50);
    assert.equal(result.successCount, expectedSuccessIds.size);
    assert.equal(result.failureCount, expectedFailureIds.size);

    for (const r of result.results) {
      if (expectedSuccessIds.has(r.agentId)) {
        assert.equal(r.status, "success");
        assert.equal(r.newStatus, "paused");
      } else {
        assert.equal(r.status, "failed");
        assert.ok(r.error);
      }
    }

    // Verify actual DB state matches the response, not just the response's
    // own bookkeeping. A failed transition must leave the agent's status
    // completely unchanged from its pre-operation value (which, for an
    // agent that was already Paused, coincidentally IS "paused" — the
    // assertion below checks against that agent's own prior status, not
    // against the literal string "paused").
    const beforeById = new Map(before.rows.map((r) => [r.id, r.lifecycle_status]));
    const after = await pool.query<{ id: string; lifecycle_status: string }>("SELECT id, lifecycle_status FROM agents WHERE id = ANY($1::uuid[])", [targetSubset]);
    for (const row of after.rows) {
      if (expectedSuccessIds.has(row.id)) assert.equal(row.lifecycle_status, "paused");
      else assert.equal(row.lifecycle_status, beforeById.get(row.id), "a failed transition must leave the agent's status exactly as it was");
    }

    // Every successful transition must have produced its OWN
    // agent_state_transitions row and its OWN audit_events row — not one
    // bulk entry for the whole operation. Filtered by triggered_by/actor_id
    // = actorId (the bulk call's real actor) rather than just to_status, so
    // this doesn't also count the fixture's OWN null-actor Active->Paused
    // seeding transitions for the agents that started already Paused.
    const transitionRows = await pool.query(
      "SELECT agent_id FROM agent_state_transitions WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]) AND to_status = 'paused' AND triggered_by = $3",
      [tenant.id, targetSubset, actorId],
    );
    assert.equal(transitionRows.rows.length, expectedSuccessIds.size);

    const auditRows = await pool.query(
      "SELECT resource_id FROM audit_events WHERE tenant_id = $1 AND action = 'agent.lifecycle_transition' AND resource_id = ANY($2::uuid[]) AND details->>'toStatus' = 'paused' AND actor_id = $3",
      [tenant.id, targetSubset, actorId],
    );
    assert.equal(auditRows.rows.length, expectedSuccessIds.size);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
    await inFlightOperations.onModuleDestroy();
    await pubsub.onModuleDestroy();
  }
});

test("bulk operation resolves agents via filter criteria within the caller's tenant scope only (RLS/tenant isolation)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, agentsService, lifecycleService, bulkLifecycleService, inFlightOperations, pubsub } = await buildRig(pool);
  const slugA = randomSlug();
  const slugB = randomSlug();

  try {
    const tenantA = await saga.provision({ name: "Bulk Filter Tenant A", slug: slugA, dataResidencyRegion: "us", actorId: null });
    const tenantB = await saga.provision({ name: "Bulk Filter Tenant B", slug: slugB, dataResidencyRegion: "us", actorId: null });

    const a1 = await agentsService.create(pool, tenantA.id, null, { name: "A Agent 1", framework: "langchain", connectionConfig: {} });
    const a2 = await agentsService.create(pool, tenantA.id, null, { name: "A Agent 2", framework: "langchain", connectionConfig: {} });
    const b1 = await agentsService.create(pool, tenantB.id, null, { name: "B Agent 1", framework: "langchain", connectionConfig: {} });
    for (const agent of [a1, a2, b1]) {
      const tenantId = agent.tenantId;
      await lifecycleService.transition(pool, tenantId, null, agent.id, "active", undefined);
    }

    const result = await bulkLifecycleService.execute(pool, tenantA.id, null, { filter: { framework: "langchain" as any }, targetStatus: "paused" as any });

    assert.equal(result.totalCount, 2, "the filter must resolve only tenant A's 2 agents, never tenant B's");
    assert.deepEqual(new Set(result.results.map((r) => r.agentId)), new Set([a1.id, a2.id]));

    const bRow = await pool.query("SELECT lifecycle_status FROM agents WHERE id = $1", [b1.id]);
    assert.equal(bRow.rows[0].lifecycle_status, "active", "tenant B's agent must be completely untouched by tenant A's bulk request");
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
    await inFlightOperations.onModuleDestroy();
    await pubsub.onModuleDestroy();
  }
});

test("bulk pause of 100 agents completes within the 30-second budget", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, agentsService, lifecycleService, bulkLifecycleService, inFlightOperations, pubsub } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Bulk Perf Co", slug, dataResidencyRegion: "us", actorId: null });
    const agentIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const created = await agentsService.create(pool, tenant.id, null, { name: `Perf Agent ${i}`, framework: "generic_rest", connectionConfig: {} });
      await lifecycleService.transition(pool, tenant.id, null, created.id, "active", undefined);
      agentIds.push(created.id);
    }

    const start = process.hrtime.bigint();
    const result = await bulkLifecycleService.execute(pool, tenant.id, null, { agentIds, targetStatus: "paused" as any });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    assert.equal(result.successCount, 100);
    assert.ok(elapsedMs < 30_000, `expected under 30s, took ${elapsedMs}ms`);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
    await inFlightOperations.onModuleDestroy();
    await pubsub.onModuleDestroy();
  }
});
