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
import { TraceRepository } from "../../src/traces/trace.repository";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-traces-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM agent_execution_traces WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenantAndAgent(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const tenant = await saga.provision({ name: `Traces ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(pool, tenant.id, null, { name: "Traced Agent", framework: "langchain", connectionConfig: {} });
  return { tenant, agent };
}

test("real Postgres: create + findByAgentId round-trip, newest first, respects status filter and pagination", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const { tenant, agent } = await provisionTenantAndAgent(pool, slug);
    const repository = new TraceRepository(pool);

    await repository.create(pool, tenant.id, agent.id, {
      status: "completed",
      startedAt: new Date("2026-08-16T00:00:00Z"),
      durationMs: 500,
      steps: [{ stepName: "step-1", toolName: "tool-a", durationMs: 500, status: "success", inputSummary: "input", outputSummary: "output" }],
    });
    await repository.create(pool, tenant.id, agent.id, {
      status: "failed",
      startedAt: new Date("2026-08-16T01:00:00Z"),
      durationMs: 200,
      steps: [{ stepName: "step-1", toolName: null, durationMs: 200, status: "error", inputSummary: "input2", outputSummary: "error message" }],
    });

    const all = await repository.findByAgentId(pool, tenant.id, agent.id, { limit: 20, offset: 0 });
    assert.equal(all.total, 2);
    assert.equal(all.rows[0].status, "failed", "newest (started_at DESC) must come first");
    assert.deepEqual(all.rows[0].steps[0], { stepName: "step-1", toolName: null, durationMs: 200, status: "error", inputSummary: "input2", outputSummary: "error message" });

    const filtered = await repository.findByAgentId(pool, tenant.id, agent.id, { status: "completed", limit: 20, offset: 0 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.rows[0].status, "completed");

    const paginated = await repository.findByAgentId(pool, tenant.id, agent.id, { limit: 1, offset: 1 });
    assert.equal(paginated.rows.length, 1);
    assert.equal(paginated.rows[0].status, "completed", "offset 1 must skip the newest row");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: a query scoped to tenant A never returns tenant B's traces", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugA = randomSlug();
  const slugB = randomSlug();
  try {
    const { tenant: tenantA, agent: agentA } = await provisionTenantAndAgent(pool, slugA);
    const { tenant: tenantB, agent: agentB } = await provisionTenantAndAgent(pool, slugB);
    const repository = new TraceRepository(pool);

    await repository.create(pool, tenantA.id, agentA.id, { status: "completed", startedAt: new Date(), durationMs: 100, steps: [] });
    await repository.create(pool, tenantB.id, agentB.id, { status: "completed", startedAt: new Date(), durationMs: 100, steps: [] });

    const resultA = await repository.findByAgentId(pool, tenantA.id, agentA.id, { limit: 20, offset: 0 });
    assert.equal(resultA.total, 1);

    // Even querying tenant A's own filter with agent B's id must return nothing — tenant_id is checked explicitly, not just agent_id.
    const crossTenantAttempt = await repository.findByAgentId(pool, tenantA.id, agentB.id, { limit: 20, offset: 0 });
    assert.equal(crossTenantAttempt.total, 0);
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
  }
});
