import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { MetricsAggregatorRepository } from "../../src/adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorService } from "../../src/adapters/metrics/metrics-aggregator.service";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { DashboardService } from "../../src/dashboard/dashboard.service";
import { HealthCacheService } from "../../src/dashboard/health-cache.service";
import { HealthDashboardRepository } from "../../src/dashboard/health-dashboard.repository";
import { HealthMetricsPublisherService } from "../../src/dashboard/health-metrics-publisher.service";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { ConnectionRegistryService } from "../../src/websocket-gateway/connection-registry.service";
import { MessageBatcherService } from "../../src/websocket-gateway/message-batcher.service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { HealthGateway } from "../../src/websocket-gateway/gateways/health.gateway";
import { WsAuthService } from "../../src/websocket-gateway/ws-auth.service";
import { WsConnectionLimitConfigService } from "../../src/websocket-gateway/ws-connection-limit-config.service";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-healthdash-${Math.random().toString(36).slice(2, 8)}`;
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

/** Migration 007's partitioned agent_metrics table only has partitions for the 24h window it was created in — ensure the CURRENT hour's partition exists before inserting, same as this codebase's own migration bootstrap call. */
async function ensureCurrentMetricsPartition(pool: Pool): Promise<void> {
  await pool.query("SELECT create_agent_metrics_partitions(now(), 24)");
}

async function provisionTenantAndAgents(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const tenant = await saga.provision({ name: `Health Dashboard ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

  const healthyAgent = await agentsService.create(pool, tenant.id, null, { name: "Healthy Agent", framework: "langchain", connectionConfig: {} });
  const errorAgent = await agentsService.create(pool, tenant.id, null, { name: "Erroring Agent", framework: "crewai", connectionConfig: {} });
  const noMetricsAgent = await agentsService.create(pool, tenant.id, null, { name: "Freshly Connected Agent", framework: "autogen", connectionConfig: {} });

  return { tenant, healthyAgent, errorAgent, noMetricsAgent };
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

test("real Postgres: a synthetic error-rate telemetry event flows through the metrics aggregator to a computed 'error' status, pushed over the health WebSocket channel", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const startedAt = Date.now();

  try {
    const { tenant, healthyAgent, errorAgent, noMetricsAgent } = await provisionTenantAndAgents(pool, slug);
    await ensureCurrentMetricsPartition(pool);

    const metricsRepository = new MetricsAggregatorRepository(pool);
    const metricsAggregator = new MetricsAggregatorService(metricsRepository);

    function syntheticEvent(agentId: string, overrides: Partial<CanonicalTelemetryEvent>): CanonicalTelemetryEvent {
      return {
        event_id: `evt-${agentId}`,
        agent_id: agentId,
        tenant_id: tenant.id,
        timestamp: new Date().toISOString(),
        event_type: TelemetryEventType.METRIC,
        latency_ms: null,
        error_rate: null,
        token_consumption: null,
        tool_call_success: null,
        tool_call_name: null,
        framework_type: "generic_rest",
        adapter_version: "test-1.0.0",
        raw_payload_hash: "test-hash",
        metadata: {},
        ...overrides,
      };
    }

    // "synthetic telemetry event" for the healthy agent: low error rate, low latency.
    await metricsAggregator.recordCanonicalEvent(pool, syntheticEvent(healthyAgent.id, { latency_ms: 120, error_rate: 0, token_consumption: 10, tool_call_success: true }));

    // "synthetic telemetry event" for the erroring agent: error rate above the 'error' threshold.
    await metricsAggregator.recordCanonicalEvent(pool, syntheticEvent(errorAgent.id, { latency_ms: 300, error_rate: 0.5, token_consumption: 5, tool_call_success: false }));

    const repository = new HealthDashboardRepository(pool);
    let dbRows: Awaited<ReturnType<typeof repository.findFleetHealth>>["rows"] = [];
    for (let attempt = 0; attempt < 5 && dbRows.length < 2; attempt++) {
      await refreshHealthView(pool);
      const scopedClient = await pool.connect();
      try {
        await scopedClient.query("BEGIN");
        await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
        const result = await repository.findFleetHealth(scopedClient, tenant.id, { teamIds: null, limit: 50, offset: 0 });
        dbRows = result.rows.filter((r) => r.metricsBucket !== null);
        await scopedClient.query("COMMIT");
      } finally {
        scopedClient.release();
      }
      if (dbRows.length < 2) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(dbRows.length >= 2, "both agents with recorded metrics must have a joined aggregate row");

    const cache = new HealthCacheService();
    const phiScrubber = new PhiScrubberService();
    const auditService = new InMemoryAuditService();
    const teamMembershipRepository = { getUserTeamIds: async () => [] } as any;
    const dashboardService = new DashboardService(repository, teamMembershipRepository, cache, phiScrubber, auditService);

    const scopedClient = await pool.connect();
    let fleetResult;
    try {
      await scopedClient.query("BEGIN");
      await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
      fleetResult = await dashboardService.getFleetHealth(scopedClient, { tenantId: tenant.id, actorId: null, roles: ["platform_admin"] }, {});
      await scopedClient.query("COMMIT");
    } finally {
      scopedClient.release();
    }

    const byId = new Map(fleetResult.agents.map((a) => [a.id, a]));
    assert.equal(byId.get(errorAgent.id)?.status, "error");
    assert.equal(byId.get(healthyAgent.id)?.status, "active");
    assert.equal(byId.get(noMetricsAgent.id)?.status, "active", "an agent with no metrics yet defaults to active, not a spurious error/degraded state");

    // --- WebSocket push leg: HealthMetricsPublisherService -> RedisPubSubService -> HealthGateway ---
    const pubsub = new RedisPubSubService();
    const publisher = new HealthMetricsPublisherService(repository, dashboardService, pubsub);

    const keyService = new JwtKeyService();
    const verifier = new MultiKeyJwtVerifier(keyService);
    const authService = new WsAuthService(verifier);
    const connectionRegistry = new ConnectionRegistryService();
    const gatewayPubsub = new RedisPubSubService();
    const batcher = new MessageBatcherService();
    const wsMetrics = new WsMetricsService();
    const limitConfig = new WsConnectionLimitConfigService();
    const gateway = new HealthGateway(authService, connectionRegistry, gatewayPubsub, batcher, wsMetrics, limitConfig);

    const sent: string[] = [];
    const fakeClient = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => sent.push(data),
      close: () => undefined,
      terminate: () => undefined,
      ping: () => undefined,
      on: () => undefined,
    };
    const token = keyService.sign({ tid: tenant.id, roles: ["platform_admin"] }, "user-1", 900);

    try {
      await gateway.handleConnection(fakeClient as any, { url: `/ws/health?token=${token}` } as any);

      await publisher.publishUpdate(pool, tenant.id);
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(sent.length, 1, "the connected client must receive exactly one batched health push");
      const frame = JSON.parse(sent[0]);
      assert.equal(frame.channel, "health");
      const pushedSnapshot = frame.batch[0] as { agents: Array<{ id: string; status: string }> };
      const pushedById = new Map(pushedSnapshot.agents.map((a) => [a.id, a]));
      assert.equal(pushedById.get(errorAgent.id)?.status, "error");

      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 30_000, `end-to-end synthetic-event-to-WebSocket-push flow took ${elapsedMs}ms, expected under the dashboard's own 30s freshness target`);
    } finally {
      await gateway.handleDisconnect(fakeClient as any);
      await connectionRegistry.onModuleDestroy();
      await gatewayPubsub.onModuleDestroy();
      await pubsub.onModuleDestroy();
      await cache.onModuleDestroy();
    }
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres RLS: tenant A never sees tenant B's agents in the fleet health query", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugA = randomSlug();
  const slugB = randomSlug();

  try {
    const { tenant: tenantA, healthyAgent: agentA } = await provisionTenantAndAgents(pool, slugA);
    const { healthyAgent: agentB } = await provisionTenantAndAgents(pool, slugB);

    const repository = new HealthDashboardRepository(pool);
    const scopedClient = await pool.connect();
    try {
      await scopedClient.query("BEGIN");
      await scopedClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenantA.id]);
      const result = await repository.findFleetHealth(scopedClient, tenantA.id, { teamIds: null, limit: 50, offset: 0 });
      const ids = result.rows.map((r) => r.id);
      assert.ok(ids.includes(agentA.id));
      assert.ok(!ids.includes(agentB.id), "tenant A's scoped query must never surface tenant B's agent");
      await scopedClient.query("COMMIT");
    } finally {
      scopedClient.release();
    }
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
  }
});
