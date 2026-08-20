import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Pool } from "pg";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { CreditTransactionRepository } from "../../src/credits/credit-transaction.repository";
import { OrgUsageCacheService } from "../../src/dashboard/org-usage/org-usage-cache.service";
import { OrgUsageDashboardRepository } from "../../src/dashboard/org-usage/org-usage-dashboard.repository";
import { OrgUsageDashboardService } from "../../src/dashboard/org-usage/org-usage-dashboard.service";
import { OrgUsagePublisherService } from "../../src/dashboard/org-usage/org-usage-publisher.service";
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
import { OrgUsageGateway } from "../../src/websocket-gateway/gateways/org-usage.gateway";
import { WsAuthService } from "../../src/websocket-gateway/ws-auth.service";
import { WsConnectionLimitConfigService } from "../../src/websocket-gateway/ws-connection-limit-config.service";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-orgusage-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A dedicated `ams_app`-role pool — per this WO's own testing convention
 * (see backend/test/audit/query/audit-log-query.repository-integration.test.ts),
 * genuine RLS enforcement must be exercised as the application's own
 * least-privileged DB role, NOT the local `postgres` superuser
 * (superusers implicitly bypass RLS regardless of FORCE ROW LEVEL
 * SECURITY, so a superuser-connected "RLS test" would pass even if RLS
 * were completely broken).
 */
function amsAppPool(): Pool {
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  return new Pool({ connectionString: appUrl.toString() });
}

async function withTenantContext<T>(pool: Pool, tenantId: string, fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupTenant(adminPool: Pool, slug: string): Promise<void> {
  const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await adminPool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenantWithAgent(adminPool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), new PostgresAuditService(adminPool));
  const audit = new PostgresAuditService(adminPool);
  const encryptionService = new EncryptionService(adminPool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(adminPool);
  const agentsService = new AgentsService(adminPool, agentsRepository, encryptionService, audit, buildAdapterHealthService(adminPool));
  const tenant = await saga.provision({ name: `Org Usage ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(adminPool, tenant.id, null, { name: "Consumption Test Agent", framework: "langchain", connectionConfig: {} });
  // Agents are created with lifecycle_status='connecting' (migration
  // 004's own default) — this WO's "active agent count" KPI counts
  // lifecycle_status='active' specifically, so test fixtures activate
  // the agent directly rather than exercising the full lifecycle
  // transition flow (WO-032/agents.lifecycle), which is out of scope here.
  await adminPool.query("UPDATE agents SET lifecycle_status = 'active' WHERE id = $1", [agent.id]);
  return { tenant, agent };
}

/** Inserts a mock "credit consumption event" for `daysAgo` days ago — this is the synthetic telemetry event this WO's own AC 9 describes flowing through to the dashboard. */
async function insertMockConsumptionEvent(pool: Pool, tenantId: string, agentId: string, credits: number, daysAgo: number): Promise<void> {
  const repository = new CreditTransactionRepository(pool);
  const occurredAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await withTenantContext(pool, tenantId, (client) =>
    repository.recordTransaction(client, tenantId, {
      teamId: null,
      agentId,
      entryType: "debit",
      amount: credits,
      actionType: "agent_execution",
      description: "synthetic telemetry event",
      actorId: null,
      occurredAt,
    }),
  );
}

async function allocateCredits(pool: Pool, tenantId: string, credits: number): Promise<void> {
  const repository = new CreditTransactionRepository(pool);
  await withTenantContext(pool, tenantId, (client) =>
    repository.recordTransaction(client, tenantId, { teamId: null, agentId: null, entryType: "credit", amount: credits, actionType: "budget_allocation", description: "initial allocation", actorId: null }),
  );
}

test("real Postgres RLS: tenant A's ams_app-scoped query never sees tenant B's credit_transactions rows, even with no explicit tenant_id predicate", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slugA = randomSlug();
  const slugB = randomSlug();

  try {
    const { tenant: tenantA, agent: agentA } = await provisionTenantWithAgent(adminPool, slugA);
    const { tenant: tenantB, agent: agentB } = await provisionTenantWithAgent(adminPool, slugB);

    await insertMockConsumptionEvent(appPool, tenantA.id, agentA.id, 100, 0);
    await insertMockConsumptionEvent(appPool, tenantB.id, agentB.id, 200, 0);

    // Genuine RLS assertion: query the base table directly, with app.current_tenant set to tenant A, and NO WHERE tenant_id clause at all — RLS's own FORCE ROW LEVEL SECURITY policy (migration 006/052) is the only thing that can make this return zero cross-tenant rows.
    const result: { rows: Array<{ tenant_id: string; agent_id: string; credits_debit: number }> } = await withTenantContext(appPool, tenantA.id, (client) =>
      client.query("SELECT tenant_id, agent_id, credits_debit FROM credit_transactions"),
    );
    assert.ok(result.rows.length >= 1, "tenant A's own transaction must still be visible");
    assert.ok(result.rows.every((r) => r.tenant_id === tenantA.id), "zero rows from any other tenant must ever be visible under tenant A's RLS context");
    assert.ok(!result.rows.some((r) => r.agent_id === agentB.id), "tenant B's agent/transaction must never leak into tenant A's query");
  } finally {
    await cleanupTenant(adminPool, slugA);
    await cleanupTenant(adminPool, slugB);
    await adminPool.end();
    await appPool.end();
  }
});

test("real Postgres RLS: the _scoped consumption aggregate views enforce the same isolation as the base table", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slugA = randomSlug();
  const slugB = randomSlug();

  try {
    const { tenant: tenantA, agent: agentA } = await provisionTenantWithAgent(adminPool, slugA);
    const { tenant: tenantB, agent: agentB } = await provisionTenantWithAgent(adminPool, slugB);

    await insertMockConsumptionEvent(appPool, tenantA.id, agentA.id, 50, 1);
    await insertMockConsumptionEvent(appPool, tenantB.id, agentB.id, 999, 1);

    const repository = new OrgUsageDashboardRepository(appPool);
    await repository.refreshAggregates(adminPool);

    const trendA = await withTenantContext(appPool, tenantA.id, (client) => repository.getConsumptionTrend(client, tenantA.id, 30, "daily"));
    const totalA = trendA.reduce((sum, p) => sum + p.credits, 0);
    assert.equal(totalA, 50, "tenant A's trend must reflect only its own 50 credits, never tenant B's 999");

    const breakdownA = await withTenantContext(appPool, tenantA.id, (client) => repository.getAgentBreakdown(client, tenantA.id, 30));
    assert.ok(!breakdownA.some((a) => a.agentId === agentB.id), "tenant B's agent must never appear in tenant A's breakdown");
  } finally {
    await cleanupTenant(adminPool, slugA);
    await cleanupTenant(adminPool, slugB);
    await adminPool.end();
    await appPool.end();
  }
});

test("full pipeline: a synthetic credit-consumption event flows through to the org usage dashboard AND its WebSocket push, within the 30s freshness budget", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const startedAt = Date.now();

  try {
    const { tenant, agent } = await provisionTenantWithAgent(adminPool, slug);
    await allocateCredits(appPool, tenant.id, 10_000);

    // "mock telemetry event published -> consumed by stream processor -> written to the ledger": this codebase's real, always-on write path IS CreditTransactionRepository.recordTransaction (see migration 058's own comment on why a separate credit_consumption_events table would be an unpopulated duplicate) — inserting through it here is the same call MeteringEngineService (WO-066) makes for a genuine metered event, not a shortcut around it.
    await insertMockConsumptionEvent(appPool, tenant.id, agent.id, 42, 0);

    const repository = new OrgUsageDashboardRepository(appPool);
    const cache = new OrgUsageCacheService();

    // Every Redis-backed resource created from here down (cache, and the
    // two RedisPubSubServices further below) MUST be closed even if an
    // assertion throws — an un-quit ioredis client keeps its TCP
    // connection alive and hangs the whole test process long past this
    // test's own completion, masking any assertion failure behind what
    // looks like a stuck run rather than a clean red X.
    try {
      const auditService = new PostgresAuditService(adminPool);
      const dashboardService = new OrgUsageDashboardService(repository, cache, auditService);

      let summary;
      for (let attempt = 0; attempt < 5; attempt++) {
        await repository.refreshAggregates(adminPool);
        summary = await withTenantContext(appPool, tenant.id, (client) => dashboardService.getOrgUsageSummary(client, { tenantId: tenant.id, actorId: null }));
        if (summary.balance.consumed >= 42) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      assert.ok(summary, "a summary must have been computed");
      assert.equal(summary!.balance.consumed, 42);
      assert.equal(summary!.balance.remaining, 10_000 - 42);
      assert.equal(summary!.activeAgents, 1);
      assert.ok(summary!.agentBreakdown.some((a) => a.agentId === agent.id && a.creditsConsumed === 42));

      // --- WebSocket push leg: OrgUsagePublisherService -> RedisPubSubService -> OrgUsageGateway ---
      const publisherPubsub = new RedisPubSubService();
      const publisher = new OrgUsagePublisherService(repository, dashboardService, publisherPubsub);

      const keyService = new JwtKeyService();
      const verifier = new MultiKeyJwtVerifier(keyService);
      const authService = new WsAuthService(verifier);
      const connectionRegistry = new ConnectionRegistryService();
      const gatewayPubsub = new RedisPubSubService();
      const batcher = new MessageBatcherService();
      const wsMetrics = new WsMetricsService();
      const limitConfig = new WsConnectionLimitConfigService();
      const gateway = new OrgUsageGateway(authService, connectionRegistry, gatewayPubsub, batcher, wsMetrics, limitConfig);

      class FakeSocket extends EventEmitter {
        readyState = 1;
        readonly OPEN = 1;
        sent: string[] = [];
        send(data: string) {
          this.sent.push(data);
        }
        close() {
          this.readyState = 3;
        }
        terminate() {
          this.readyState = 3;
        }
        ping() {
          /* no-op */
        }
      }
      const fakeClient = new FakeSocket();
      const token = keyService.sign({ tid: tenant.id, roles: ["platform_admin"] }, "user-1", 900);

      try {
        await gateway.handleConnection(fakeClient as any, { url: `/ws/dashboard/usage/org?token=${token}` } as any);

        await publisher.publishUpdate(adminPool, tenant.id);
        await new Promise((resolve) => setTimeout(resolve, 250));

        assert.equal(fakeClient.sent.length, 1, "the connected client must receive exactly one batched org-usage push");
        const frame = JSON.parse(fakeClient.sent[0]);
        assert.equal(frame.channel, "org_usage");
        const pushed = frame.batch[0] as { type: string; data: { balance: { consumed: number } } };
        assert.equal(pushed.type, "usage_update");
        assert.equal(pushed.data.balance.consumed, 42);

        const elapsedMs = Date.now() - startedAt;
        assert.ok(elapsedMs < 30_000, `end-to-end synthetic-event-to-WebSocket-push flow took ${elapsedMs}ms, expected under the dashboard's own 30s freshness target`);
      } finally {
        await gateway.handleDisconnect(fakeClient as any);
        await connectionRegistry.onModuleDestroy();
        await gatewayPubsub.onModuleDestroy();
        await publisherPubsub.onModuleDestroy();
      }
    } finally {
      await cache.onModuleDestroy();
    }
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
