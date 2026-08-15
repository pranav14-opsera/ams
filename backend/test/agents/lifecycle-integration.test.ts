import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentInFlightOperationsService } from "../../src/agents/agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "../../src/agents/agent-state-transitions.repository";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { LifecycleService } from "../../src/agents/lifecycle.service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const skip = !DATABASE_URL || !REDIS_URL;

function randomSlug(): string {
  return `test-lifecycle-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_state_transitions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const transitionsRepository = new AgentStateTransitionsRepository(pool);
  const inFlightOperations = new AgentInFlightOperationsService();
  const pubsub = new RedisPubSubService();
  const lifecycleService = new LifecycleService(agentsRepository, transitionsRepository, audit, inFlightOperations, pubsub);
  return { saga, agentsService, lifecycleService, transitionsRepository, inFlightOperations, pubsub };
}

test("full lifecycle flow: register -> activate -> pause -> resume -> retire -> decommission, verifying agent + audit state at each step", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, agentsService, lifecycleService, transitionsRepository, inFlightOperations, pubsub } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Lifecycle Flow Co", slug, dataResidencyRegion: "us", actorId: null });
    const actorId = (await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, 'lifecycle-actor@example.com', 'Lifecycle Actor') RETURNING id", [tenant.id])).rows[0]
      .id;

    const created = await agentsService.create(pool, tenant.id, actorId, { name: "Flow Agent", framework: "langchain", connectionConfig: { apiKey: "x" } });
    assert.equal(created.lifecycleStatus, "connecting");

    // connecting -> active
    const activated = await lifecycleService.transition(pool, tenant.id, actorId, created.id, "active", undefined);
    assert.equal(activated.agent.lifecycleStatus, "active");
    assert.equal(activated.warning, null);

    // active -> paused, with a real in-flight operation registered — the
    // drain must actually observe and wait for it, not just no-op.
    await inFlightOperations.increment(created.id);
    setTimeout(() => {
      inFlightOperations.decrement(created.id).catch(() => undefined);
    }, 150);
    const paused = await lifecycleService.transition(pool, tenant.id, actorId, created.id, "paused", undefined, 5000);
    assert.equal(paused.agent.lifecycleStatus, "paused");
    assert.equal(paused.warning, null, "the in-flight op drained well within the timeout, so no warning is expected");

    // paused -> active
    const resumed = await lifecycleService.transition(pool, tenant.id, actorId, created.id, "active", undefined);
    assert.equal(resumed.agent.lifecycleStatus, "active");

    // active -> retired (requires justification)
    const retired = await lifecycleService.transition(pool, tenant.id, actorId, created.id, "retired", "end of pilot program");
    assert.equal(retired.agent.lifecycleStatus, "retired");

    // retired -> decommissioned (requires justification)
    const decommissioned = await lifecycleService.transition(pool, tenant.id, actorId, created.id, "decommissioned", "pilot program concluded");
    assert.equal(decommissioned.agent.lifecycleStatus, "decommissioned");

    // Verify persisted agent state.
    const finalRow = await pool.query("SELECT lifecycle_status, version FROM agents WHERE id = $1", [created.id]);
    assert.equal(finalRow.rows[0].lifecycle_status, "decommissioned");
    assert.equal(finalRow.rows[0].version, 6, "one version bump for create's implicit version=1 plus 5 transitions");

    // Verify the full transition history was persisted in order.
    const transitions = await transitionsRepository.findByAgentId(pool, tenant.id, created.id);
    assert.deepEqual(
      transitions.map((t) => `${t.from_status}->${t.to_status}`),
      ["connecting->active", "active->paused", "paused->active", "active->retired", "retired->decommissioned"],
    );
    assert.equal(transitions.every((t) => t.triggered_by === actorId), true);
    assert.equal(transitions.find((t) => t.to_status === "retired")!.reason, "end of pilot program");

    // Verify each transition also produced its own audit_events row.
    const auditRows = await pool.query(
      "SELECT action, details FROM audit_events WHERE tenant_id = $1 AND resource_id = $2 AND action = 'agent.lifecycle_transition' ORDER BY occurred_at",
      [tenant.id, created.id],
    );
    assert.equal(auditRows.rows.length, 5);
    assert.equal(auditRows.rows[0].details.toStatus, "active");
    assert.equal(auditRows.rows[4].details.toStatus, "decommissioned");

    // Attempting to reactivate a decommissioned agent must fail with 409.
    await assert.rejects(
      () => lifecycleService.transition(pool, tenant.id, actorId, created.id, "active", undefined),
      (err: any) => {
        assert.equal(err.getStatus(), 409);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
    await inFlightOperations.onModuleDestroy();
    await pubsub.onModuleDestroy();
  }
});

test("pausing an agent whose in-flight operations never drain still transitions to Paused, with a warning flag and logged incomplete count", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, agentsService, lifecycleService, transitionsRepository, inFlightOperations, pubsub } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "Lifecycle Timeout Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "Stuck Agent", framework: "crewai", connectionConfig: {} });
    await lifecycleService.transition(pool, tenant.id, null, created.id, "active", undefined);

    // Two operations register as in-flight and are deliberately never
    // decremented within the drain window.
    await inFlightOperations.increment(created.id);
    await inFlightOperations.increment(created.id);

    const result = await lifecycleService.transition(pool, tenant.id, null, created.id, "paused", undefined, 300);
    assert.equal(result.agent.lifecycleStatus, "paused", "must still pause even though the drain timed out");
    assert.ok(result.warning);
    assert.match(result.warning!, /2 in-flight operation/);

    const transitions = await transitionsRepository.findByAgentId(pool, tenant.id, created.id);
    const pauseTransition = transitions.find((t) => t.to_status === "paused")!;
    assert.equal(pauseTransition.warning_flag, true);
    assert.equal(pauseTransition.incomplete_operations_count, 2);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
    await inFlightOperations.onModuleDestroy();
    await pubsub.onModuleDestroy();
  }
});
