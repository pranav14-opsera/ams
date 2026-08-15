import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { MetricsAggregatorRepository } from "../../../src/adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorService } from "../../../src/adapters/metrics/metrics-aggregator.service";
import type { CanonicalTelemetryEvent } from "../../../src/adapters/schemas/canonical-telemetry";
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

function randomSlug(): string {
  return `test-metrics-${Math.random().toString(36).slice(2, 8)}`;
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

/**
 * The view starts unpopulated (WITH NO DATA) — the very first refresh
 * anywhere in this database must be plain, every one after that can use
 * CONCURRENTLY (migration 007's own documented requirement). Retries a
 * few times on failure: agent_metrics_5min_agg is ONE shared, global
 * materialized view (not per-test-isolated), so a concurrent refresh
 * from another test file running in parallel can transiently block or
 * fail this one — found via testing (passed in isolation, flaked only
 * under the full concurrent suite).
 */
async function refreshAggregateView(pool: Pool): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY agent_metrics_5min_agg");
      return;
    } catch (err) {
      lastErr = err;
      try {
        await pool.query("REFRESH MATERIALIZED VIEW agent_metrics_5min_agg");
        return;
      } catch (err2) {
        lastErr = err2;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  throw lastErr;
}

function canonicalEvent(tenantId: string, agentId: string, overrides: Partial<CanonicalTelemetryEvent> = {}): CanonicalTelemetryEvent {
  return {
    event_id: randomUUID(),
    agent_id: agentId,
    tenant_id: tenantId,
    timestamp: new Date().toISOString(),
    event_type: "metric" as any,
    latency_ms: 100,
    error_rate: 0,
    token_consumption: 10,
    tool_call_success: null,
    tool_call_name: null,
    framework_type: "generic_rest",
    adapter_version: "1.0.0",
    raw_payload_hash: "a".repeat(64),
    metadata: {},
    ...overrides,
  };
}

test("recordCanonicalEvent writes real rows that the pre-existing 5-minute aggregate view correctly rolls up (P50/P99 latency, error rate)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
    const metricsRepository = new MetricsAggregatorRepository(pool);
    const metricsService = new MetricsAggregatorService(metricsRepository);

    const tenant = await saga.provision({ name: "Metrics Agg Co", slug, dataResidencyRegion: "us", actorId: null });
    const agent = await agentsService.create(pool, tenant.id, null, { name: "Metrics Test Agent", framework: "generic_rest", connectionConfig: {} });

    const latencies = [50, 100, 150, 200, 900]; // deliberately one outlier so P50 != P99
    for (const latencyMs of latencies) {
      await metricsService.recordCanonicalEvent(pool, canonicalEvent(tenant.id, agent.id, { latency_ms: latencyMs, error_rate: 0 }));
    }
    // One error, to make error_rate_avg meaningfully non-zero.
    await metricsService.recordCanonicalEvent(pool, canonicalEvent(tenant.id, agent.id, { latency_ms: null, error_rate: 1 }));

    const rawRows = await pool.query("SELECT metric_name, value FROM agent_metrics WHERE tenant_id = $1 AND agent_id = $2", [tenant.id, agent.id]);
    // 5 events each record BOTH a latency_ms row and an error_rate:0 row
    // (0 is a meaningful value, not treated as absent), plus the 6th
    // event records only its error_rate:1 row (latency_ms is null there).
    assert.equal(rawRows.rows.length, 11);
    assert.equal(rawRows.rows.filter((r) => r.metric_name === "latency_ms").length, 5);
    assert.equal(rawRows.rows.filter((r) => r.metric_name === "error_rate").length, 6);

    // agent_metrics_5min_agg_scoped requires app.current_tenant to be
    // set (an unset context raises a Postgres error casting '' to uuid,
    // rather than silently matching nothing) — same tenant-scoped
    // transaction TenantContextMiddleware sets up per request in
    // production. Retried a few times: this is ONE shared, global
    // materialized view (not per-test-isolated), so a refresh racing
    // another test file's own concurrent refresh can transiently miss
    // this agent's just-inserted rows — found via testing (passed in
    // isolation, flaked only under the full concurrent suite).
    let aggregates: Awaited<ReturnType<typeof metricsRepository.findAggregates>> = [];
    for (let attempt = 0; attempt < 5 && aggregates.length === 0; attempt++) {
      await refreshAggregateView(pool);
      const scopedClient = await pool.connect();
      try {
        await scopedClient.query("BEGIN");
        await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
        aggregates = await metricsRepository.findAggregates(tenant.id, agent.id, new Date(Date.now() - 10 * 60_000).toISOString(), scopedClient);
        await scopedClient.query("COMMIT");
      } finally {
        scopedClient.release();
      }
      if (aggregates.length === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(aggregates.length >= 1, "at least one 5-minute bucket must exist for this agent");
    const bucket = aggregates[aggregates.length - 1];
    assert.ok(bucket.latencyP50Ms !== null && bucket.latencyP99Ms !== null);
    assert.ok(bucket.latencyP99Ms! >= bucket.latencyP50Ms!, "P99 must be at least P50 given the outlier");
    assert.ok(bucket.errorRateAvg! > 0, "the recorded error must show up in the aggregated error rate");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("findAggregates never returns another tenant's data (RLS-backed tenant isolation, same as the underlying agent_metrics table)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugA = randomSlug();
  const slugB = randomSlug();
  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
    const metricsRepository = new MetricsAggregatorRepository(pool);
    const metricsService = new MetricsAggregatorService(metricsRepository);

    const tenantA = await saga.provision({ name: "Metrics Tenant A", slug: slugA, dataResidencyRegion: "us", actorId: null });
    const tenantB = await saga.provision({ name: "Metrics Tenant B", slug: slugB, dataResidencyRegion: "us", actorId: null });
    const agentA = await agentsService.create(pool, tenantA.id, null, { name: "Agent A", framework: "generic_rest", connectionConfig: {} });
    const agentB = await agentsService.create(pool, tenantB.id, null, { name: "Agent B", framework: "generic_rest", connectionConfig: {} });

    await metricsService.recordCanonicalEvent(pool, canonicalEvent(tenantA.id, agentA.id, { latency_ms: 42 }));
    await metricsService.recordCanonicalEvent(pool, canonicalEvent(tenantB.id, agentB.id, { latency_ms: 999 }));

    await refreshAggregateView(pool);

    // findAggregates reads agent_metrics_5min_agg_scoped, which filters
    // by current_setting('app.current_tenant') — unlike this codebase's
    // other repositories (which additionally filter by an explicit
    // tenant_id WHERE clause and tolerate an unset context), this VIEW
    // requires app.current_tenant to be set at all: with it unset,
    // casting '' to uuid raises a real Postgres error rather than
    // silently matching nothing (found via testing this exact call
    // without a tenant-scoped client). Mirrors exactly what
    // TenantContextMiddleware does per request in production.
    const scopedClient = await pool.connect();
    let aggregatesA;
    try {
      await scopedClient.query("BEGIN");
      await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenantA.id]);
      aggregatesA = await metricsRepository.findAggregates(tenantA.id, agentA.id, new Date(Date.now() - 10 * 60_000).toISOString(), scopedClient);
      await scopedClient.query("COMMIT");
    } finally {
      scopedClient.release();
    }
    assert.ok(aggregatesA.every((a) => a.latencyP50Ms !== 999), "tenant A's scoped read must never surface tenant B's 999ms latency value");
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
  }
});
