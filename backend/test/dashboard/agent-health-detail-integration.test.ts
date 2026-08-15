import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { MetricsAggregatorRepository } from "../../src/adapters/metrics/metrics-aggregator.repository";
import { AgentStateTransitionsRepository } from "../../src/agents/agent-state-transitions.repository";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { AgentHealthDetailService } from "../../src/dashboard/agent-health-detail.service";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { TeamMembershipRepository } from "../../src/rbac/team-membership.repository";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TraceRepository } from "../../src/traces/trace.repository";
import { TraceService } from "../../src/traces/trace.service";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-drilldown-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM agent_execution_traces WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_state_transitions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_metrics WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function ensureCurrentMetricsPartition(pool: Pool): Promise<void> {
  await pool.query("SELECT create_agent_metrics_partitions(now(), 24)");
}

async function refreshView(pool: Pool, viewName: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);
      return;
    } catch (err) {
      lastErr = err;
      try {
        await pool.query(`REFRESH MATERIALIZED VIEW ${viewName}`);
        return;
      } catch (err2) {
        lastErr = err2;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  throw lastErr;
}

async function provisionTenantAndAgent(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const tenant = await saga.provision({ name: `Drilldown ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(pool, tenant.id, null, { name: "Drilldown Agent", framework: "langchain", connectionConfig: {} });
  return { tenant, agent, agentsRepository };
}

function buildService(pool: Pool, agentsRepository: AgentsRepository) {
  const metricsRepository = new MetricsAggregatorRepository(pool);
  const stateTransitionsRepository = new AgentStateTransitionsRepository(pool);
  const traceRepository = new TraceRepository(pool);
  const traceService = new TraceService(traceRepository, new PhiScrubberService());
  const teamMembershipRepository = new TeamMembershipRepository(pool);
  return new AgentHealthDetailService(agentsRepository, metricsRepository, stateTransitionsRepository, traceService, teamMembershipRepository);
}

test("real Postgres: getHealthHistory('24h') reads the new 1hr aggregate view with correctly tenant-scoped data", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const { tenant, agent, agentsRepository } = await provisionTenantAndAgent(pool, slug);
    await ensureCurrentMetricsPartition(pool);

    const metricsRepository = new MetricsAggregatorRepository(pool);
    await metricsRepository.recordMetric(tenant.id, agent.id, "latency_ms", 150, pool);
    await metricsRepository.recordMetric(tenant.id, agent.id, "error_rate", 0.02, pool);
    await metricsRepository.recordMetric(tenant.id, agent.id, "token_consumption", 42, pool);

    const service = buildService(pool, agentsRepository);

    let history;
    for (let attempt = 0; attempt < 5; attempt++) {
      await refreshView(pool, "agent_metrics_1hr_agg");
      const scopedClient = await pool.connect();
      try {
        await scopedClient.query("BEGIN");
        await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
        history = await service.getHealthHistory(scopedClient, { tenantId: tenant.id, actorId: null, roles: ["platform_admin"] }, agent.id, "24h");
        await scopedClient.query("COMMIT");
      } finally {
        scopedClient.release();
      }
      if (history.points.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    assert.ok(history!.points.length >= 1, "at least one 1hr bucket must exist");
    assert.equal(history!.points[0].tokenConsumptionTotal, 42);
    assert.equal(history!.range, "24h");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: full drill-down flow — lifecycle history + traces + team-scoped access denial, end to end", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const { tenant, agent, agentsRepository } = await provisionTenantAndAgent(pool, slug);
    const service = buildService(pool, agentsRepository);
    const stateTransitionsRepository = new AgentStateTransitionsRepository(pool);
    const traceRepository = new TraceRepository(pool);

    await stateTransitionsRepository.record(pool, {
      tenantId: tenant.id,
      agentId: agent.id,
      fromStatus: "connecting",
      toStatus: "active",
      justification: "initial activation",
      actorId: null,
      warningFlag: false,
      incompleteOperationsCount: null,
    });

    await traceRepository.create(pool, tenant.id, agent.id, {
      status: "completed",
      startedAt: new Date(),
      durationMs: 500,
      steps: [{ stepName: "retrieve", toolName: "vector_search", durationMs: 500, status: "success", inputSummary: "Patient MRN 12345678 lookup", outputSummary: "done" }],
    });

    const adminCtx = { tenantId: tenant.id, actorId: null, roles: ["platform_admin"] };
    const lifecycleHistory = await service.getLifecycleHistory(pool, adminCtx, agent.id);
    assert.equal(lifecycleHistory.length, 1);
    assert.equal(lifecycleHistory[0].toStatus, "active");

    const traces = await service.getTraces(pool, adminCtx, agent.id, { limit: 20, offset: 0 });
    assert.equal(traces.total, 1);
    assert.ok(!traces.rows[0].steps[0].inputSummary.includes("12345678"), "PHI must be masked end-to-end through the real service+repository+Postgres path");

    // A team_lead with no matching team membership must be denied, verified against the real agents table (team_id is null here — no team assigned).
    await assert.rejects(() => service.getLifecycleHistory(pool, { tenantId: tenant.id, actorId: "some-user", roles: ["team_lead"] }, agent.id));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
