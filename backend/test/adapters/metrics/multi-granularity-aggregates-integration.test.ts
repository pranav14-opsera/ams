import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { MetricsAggregatorRepository } from "../../../src/adapters/metrics/metrics-aggregator.repository";
import { AgentsRepository } from "../../../src/agents/agents.repository";
import { AgentsService } from "../../../src/agents/agents.service";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { buildAdapterHealthService } from "../../helpers/build-adapter-health-service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

const VIEWS = [
  { granularity: "5s" as const, materialized: "agent_health_5s_agg" },
  { granularity: "15s" as const, materialized: "agent_credits_15s_agg" },
  { granularity: "60s" as const, materialized: "agent_analytics_60s_agg" },
];

function randomSlug(): string {
  return `test-multigran-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM agent_metrics WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

/** Same shared-global-materialized-view race + WITH NO DATA first-refresh constraint as migration 007's own view (see metrics-aggregator-integration.test.ts). */
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

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function provisionTenantAndAgent(pool: Pool, slug: string, name: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const tenant = await saga.provision({ name, slug, dataResidencyRegion: "us", actorId: null });
  return { tenant, agentsService };
}

for (const { granularity, materialized } of VIEWS) {
  test(`WO-042: ${granularity} aggregate view computes token_consumption_total and tool_call_success_rate_avg`, { skip }, async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    const slug = randomSlug();
    try {
      const { tenant, agentsService } = await provisionTenantAndAgent(pool, slug, `Multigran ${granularity}`);
      const agent = await agentsService.create(pool, tenant.id, null, { name: "Agent", framework: "generic_rest", connectionConfig: {} });
      const repository = new MetricsAggregatorRepository(pool);

      await pool.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value) VALUES ($1,$2,'token_consumption',100), ($1,$2,'token_consumption',50), ($1,$2,'tool_call_success',1), ($1,$2,'tool_call_success',0)", [
        tenant.id,
        agent.id,
      ]);

      let rows: Awaited<ReturnType<typeof repository.findAggregatesByGranularity>> = [];
      for (let attempt = 0; attempt < 5 && rows.length === 0; attempt++) {
        await refreshView(pool, materialized);
        const scopedClient = await pool.connect();
        try {
          await scopedClient.query("BEGIN");
          await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
          rows = await repository.findAggregatesByGranularity(granularity, tenant.id, agent.id, new Date(Date.now() - 10 * 60_000).toISOString(), scopedClient);
          await scopedClient.query("COMMIT");
        } finally {
          scopedClient.release();
        }
        if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }

      assert.ok(rows.length >= 1, `at least one ${granularity} bucket must exist`);
      const bucket = rows[rows.length - 1];
      assert.equal(bucket.tokenConsumptionTotal, 150);
      assert.equal(bucket.toolCallSuccessRateAvg, 0.5);
    } finally {
      await cleanupTenant(pool, slug);
      await pool.end();
    }
  });

  test(`WO-042: ${granularity} aggregate view never surfaces another tenant's rows (RLS)`, { skip }, async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    const slugA = randomSlug();
    const slugB = randomSlug();
    try {
      const { tenant: tenantA, agentsService: agentsServiceA } = await provisionTenantAndAgent(pool, slugA, `Multigran A ${granularity}`);
      const { tenant: tenantB, agentsService: agentsServiceB } = await provisionTenantAndAgent(pool, slugB, `Multigran B ${granularity}`);
      const agentA = await agentsServiceA.create(pool, tenantA.id, null, { name: "Agent A", framework: "generic_rest", connectionConfig: {} });
      const agentB = await agentsServiceB.create(pool, tenantB.id, null, { name: "Agent B", framework: "generic_rest", connectionConfig: {} });
      const repository = new MetricsAggregatorRepository(pool);

      await pool.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value) VALUES ($1,$2,'latency_ms',42)", [tenantA.id, agentA.id]);
      await pool.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value) VALUES ($1,$2,'latency_ms',999)", [tenantB.id, agentB.id]);

      await refreshView(pool, materialized);

      const scopedClient = await pool.connect();
      let rowsA;
      try {
        await scopedClient.query("BEGIN");
        await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenantA.id]);
        rowsA = await repository.findAggregatesByGranularity(granularity, tenantA.id, agentA.id, new Date(Date.now() - 10 * 60_000).toISOString(), scopedClient);
        await scopedClient.query("COMMIT");
      } finally {
        scopedClient.release();
      }
      assert.ok(rowsA.every((r) => r.latencyP50Ms !== 999), "tenant A's scoped read must never surface tenant B's 999ms latency");

      // A direct cross-tenant query with the WRONG scoped context set must
      // also return zero rows for the other tenant — the literal
      // "cross-tenant queries return zero rows" acceptance criterion.
      const crossClient = await pool.connect();
      let crossRows;
      try {
        await crossClient.query("BEGIN");
        await crossClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenantA.id]);
        crossRows = await crossClient.query(`SELECT * FROM ${materialized}_scoped WHERE tenant_id = $1`, [tenantB.id]);
        await crossClient.query("COMMIT");
      } finally {
        crossClient.release();
      }
      assert.equal(crossRows.rows.length, 0, "tenant A's session context must never be able to read tenant B's rows, even by explicit tenant_id filter");
    } finally {
      await cleanupTenant(pool, slugA);
      await cleanupTenant(pool, slugB);
      await pool.end();
    }
  });
}

test("WO-042: P50/P99 latency computed by the 60s aggregate view is within 1% of a manually-computed expected value across a large multi-tenant dataset", { skip, timeout: 120_000 }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugs = Array.from({ length: 5 }, () => randomSlug());
  try {
    const tenants: Array<{ id: string }> = [];
    const agentsByTenant: string[][] = [];
    for (const slug of slugs) {
      const { tenant, agentsService } = await provisionTenantAndAgent(pool, slug, `Volume ${slug}`);
      tenants.push(tenant);
      const agentIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const agent = await agentsService.create(pool, tenant.id, null, { name: `Agent ${i}`, framework: "generic_rest", connectionConfig: {} });
        agentIds.push(agent.id);
      }
      agentsByTenant.push(agentIds);
    }
    // 5 tenants x 4 agents = 20 agents (matching the AC's "20 agents").
    const totalAgents = agentsByTenant.flat().length;
    assert.equal(totalAgents, 20);

    const ROWS_PER_AGENT = 500; // 20 agents x 500 = 10,000 rows (the AC's literal figure).
    const expectedLatenciesByAgent = new Map<string, number[]>();

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;
    for (let t = 0; t < tenants.length; t++) {
      for (const agentId of agentsByTenant[t]) {
        const latencies: number[] = [];
        for (let i = 0; i < ROWS_PER_AGENT; i++) {
          // A skewed distribution (mostly fast, occasional slow outliers)
          // so P50 and P99 are meaningfully different values to verify.
          const latency = i % 50 === 0 ? 800 + (i % 200) : 50 + (i % 100);
          latencies.push(latency);
          placeholders.push(`($${paramIndex++}, $${paramIndex++}, 'latency_ms', $${paramIndex++})`);
          values.push(tenants[t].id, agentId, latency);
        }
        expectedLatenciesByAgent.set(agentId, latencies);
      }
    }

    // Bulk insert in chunks to stay well under Postgres's parameter limit.
    const CHUNK_ROWS = 1000;
    for (let i = 0; i < placeholders.length; i += CHUNK_ROWS) {
      const chunkPlaceholders = placeholders.slice(i, i + CHUNK_ROWS);
      const chunkValues = values.slice(i * 3, (i + CHUNK_ROWS) * 3);
      const renumbered = chunkPlaceholders.map((_, idx) => `($${idx * 3 + 1}, $${idx * 3 + 2}, 'latency_ms', $${idx * 3 + 3})`);
      await pool.query(`INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value) VALUES ${renumbered.join(",")}`, chunkValues);
    }

    const rawCount = await pool.query("SELECT count(*)::int AS c FROM agent_metrics WHERE metric_name = 'latency_ms' AND tenant_id = ANY($1)", [tenants.map((t) => t.id)]);
    assert.equal(rawCount.rows[0].c, 10_000);

    await refreshView(pool, "agent_analytics_60s_agg");

    const repository = new MetricsAggregatorRepository(pool);
    for (let t = 0; t < tenants.length; t++) {
      const tenant = tenants[t];
      for (const agentId of agentsByTenant[t]) {
        const scopedClient = await pool.connect();
        let rows;
        try {
          await scopedClient.query("BEGIN");
          await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
          rows = await repository.findAggregatesByGranularity("60s", tenant.id, agentId, new Date(Date.now() - 10 * 60_000).toISOString(), scopedClient);
          await scopedClient.query("COMMIT");
        } finally {
          scopedClient.release();
        }

        const expected = expectedLatenciesByAgent.get(agentId)!.slice().sort((a, b) => a - b);
        const expectedP50 = percentile(expected, 0.5);
        const expectedP99 = percentile(expected, 0.99);

        // All rows for one agent land in the same 60-second bucket (test
        // runs in well under a minute), so a single bucket's P50/P99
        // should reflect the full expected distribution.
        const actualP50 = rows.reduce((max, r) => (r.latencyP50Ms !== null ? r.latencyP50Ms : max), null as number | null);
        const actualP99 = rows.reduce((max, r) => (r.latencyP99Ms !== null ? r.latencyP99Ms : max), null as number | null);
        assert.ok(actualP50 !== null && actualP99 !== null, `agent ${agentId} must have an aggregate bucket`);
        assert.ok(Math.abs(actualP50! - expectedP50) / expectedP50 <= 0.01, `P50 for agent ${agentId}: expected ~${expectedP50}, got ${actualP50}`);
        assert.ok(Math.abs(actualP99! - expectedP99) / expectedP99 <= 0.01, `P99 for agent ${agentId}: expected ~${expectedP99}, got ${actualP99}`);
      }
    }
  } finally {
    for (const slug of slugs) await cleanupTenant(pool, slug);
    await pool.end();
  }
});
