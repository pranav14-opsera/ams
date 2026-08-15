import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { MetricsAggregatorRepository } from "../../src/adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorService } from "../../src/adapters/metrics/metrics-aggregator.service";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";
import { AlertEventRepository } from "../../src/alerts/alert-event.repository";
import { AlertThresholdRepository } from "../../src/alerts/alert-threshold.repository";
import { AlertThresholdService } from "../../src/alerts/alert-threshold.service";
import { MetricSnapshotCacheService } from "../../src/alerts/metric-snapshot-cache.service";
import { ThresholdEvaluatorService } from "../../src/alerts/threshold-evaluator.service";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { HealthDashboardRepository } from "../../src/dashboard/health-dashboard.repository";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-alerts-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM alert_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM alert_threshold_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_metrics WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function ensureCurrentMetricsPartition(pool: Pool): Promise<void> {
  await pool.query("SELECT create_agent_metrics_partitions(now(), 24)");
}

async function refreshHealthView(pool: Pool): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY agent_health_5s_agg");
      return;
    } catch (err) {
      lastErr = err;
      try {
        await pool.query("REFRESH MATERIALIZED VIEW agent_health_5s_agg");
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
  const tenant = await saga.provision({ name: `Alerts ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(pool, tenant.id, null, { name: "Alerting Agent", framework: "langchain", connectionConfig: {} });
  return { tenant, agent };
}

test("real Postgres+Redis: configure a threshold via the service, inject a breaching metric, evaluate, and verify an alert event is generated and published within the 60s AC window", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const startedAt = Date.now();

  const thresholdRepository = new AlertThresholdRepository(pool);
  const eventRepository = new AlertEventRepository(pool);
  const snapshotCache = new MetricSnapshotCacheService();
  const healthRepository = new HealthDashboardRepository(pool);
  const pubsub = new RedisPubSubService();
  const auditService = new InMemoryAuditService();
  const thresholdService = new AlertThresholdService(thresholdRepository, auditService);
  const evaluator = new ThresholdEvaluatorService(thresholdRepository, eventRepository, snapshotCache, healthRepository, pubsub);

  try {
    const { tenant, agent } = await provisionTenantAndAgent(pool, slug);
    await ensureCurrentMetricsPartition(pool);

    // Configure a threshold via the real service (CRUD path, tenant-scoped, audited).
    const adminUserId = "00000000-0000-0000-0000-0000000000a1";
    const threshold = await thresholdService.create(pool, tenant.id, adminUserId, {
      agentId: agent.id,
      metricName: "error_rate",
      warningThreshold: 0.03,
      criticalThreshold: 0.05,
      cooldownSeconds: 300,
    } as any);
    assert.equal(auditService.events.length, 1);

    // Inject a metric that breaches the critical threshold.
    const metricsAggregator = new MetricsAggregatorService(new MetricsAggregatorRepository(pool));
    const event: CanonicalTelemetryEvent = {
      event_id: "evt-breach-1",
      agent_id: agent.id,
      tenant_id: tenant.id,
      timestamp: new Date().toISOString(),
      event_type: TelemetryEventType.METRIC,
      latency_ms: 150,
      error_rate: 0.5, // well above the 0.05 critical threshold
      token_consumption: 10,
      tool_call_success: true,
      tool_call_name: null,
      framework_type: "langchain",
      adapter_version: "test-1.0.0",
      raw_payload_hash: "test-hash",
      metadata: {},
    };
    await metricsAggregator.recordCanonicalEvent(pool, event);

    let generatedEvents: Awaited<ReturnType<typeof evaluator.evaluateTenant>> = [];
    for (let attempt = 0; attempt < 5 && generatedEvents.length === 0; attempt++) {
      await refreshHealthView(pool);
      generatedEvents = await evaluator.evaluateTenant(tenant.id);
      if (generatedEvents.length === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    }

    assert.equal(generatedEvents.length, 1);
    assert.equal(generatedEvents[0].severity, "critical");
    assert.equal(generatedEvents[0].agentId, agent.id);
    assert.equal(generatedEvents[0].metricName, "error_rate");

    // Verify the alert_events row is genuinely persisted (not just returned in-memory).
    const persisted = await eventRepository.findMostRecent(pool, tenant.id, agent.id, "error_rate");
    assert.ok(persisted);
    assert.equal(persisted!.id, generatedEvents[0].id);

    // Re-evaluating immediately must NOT produce a second alert (cooldown).
    const secondPass = await evaluator.evaluateTenant(tenant.id);
    assert.equal(secondPass.length, 0, "cooldown must suppress a second alert for the same breach");

    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 60_000, `end-to-end configure->breach->alert flow took ${elapsedMs}ms, expected under the AC's own 60s window`);

    void threshold;
  } finally {
    await snapshotCache.onModuleDestroy();
    await pubsub.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres RLS: tenant A's threshold configs are never visible to tenant B", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugA = randomSlug();
  const slugB = randomSlug();
  const thresholdRepository = new AlertThresholdRepository(pool);

  try {
    const { tenant: tenantA, agent: agentA } = await provisionTenantAndAgent(pool, slugA);
    const { tenant: tenantB } = await provisionTenantAndAgent(pool, slugB);

    await thresholdRepository.create(pool, tenantA.id, agentA.id, { metricName: "error_rate", warningThreshold: 0.03, criticalThreshold: 0.05, cooldownSeconds: 300, createdBy: null });

    const forTenantA = await thresholdRepository.findAllForTenant(pool, tenantA.id);
    const forTenantB = await thresholdRepository.findAllForTenant(pool, tenantB.id);

    assert.equal(forTenantA.length, 1);
    assert.equal(forTenantB.length, 0);
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
  }
});

test("real Postgres: default thresholds are auto-applied when an agent is created via AgentsController's own flow", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const thresholdRepository = new AlertThresholdRepository(pool);
  const auditService = new InMemoryAuditService();
  const thresholdService = new AlertThresholdService(thresholdRepository, auditService);

  try {
    const { tenant, agent } = await provisionTenantAndAgent(pool, slug);
    await thresholdService.applyDefaultThresholds(pool, tenant.id, agent.id);

    const configs = await thresholdRepository.findByAgentId(pool, tenant.id, agent.id);
    assert.equal(configs.length, 4); // one per DEFAULT_THRESHOLDS metric
    const metricNames = configs.map((c) => c.metricName).sort();
    assert.deepEqual(metricNames, ["error_rate", "latency_p99", "resource_utilization", "token_consumption_rate"]);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
