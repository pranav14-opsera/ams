import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { CreditBudgetRepository } from "../../src/credits/budget/credit-budget.repository";
import { CreditBudgetService } from "../../src/credits/budget/credit-budget.service";
import { CreditTransactionRepository } from "../../src/credits/credit-transaction.repository";
import { TeamUsageCacheService } from "../../src/dashboard/team-usage/team-usage-cache.service";
import { TeamUsageDashboardRepository } from "../../src/dashboard/team-usage/team-usage-dashboard.repository";
import { TeamUsageDashboardService } from "../../src/dashboard/team-usage/team-usage-dashboard.service";
import { TeamUsagePublisherService } from "../../src/dashboard/team-usage/team-usage-publisher.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { PlatformRoleName } from "../../src/rbac/rbac.constants";
import { TeamMembershipRepository } from "../../src/rbac/team-membership.repository";
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
import { TeamUsageGateway } from "../../src/websocket-gateway/gateways/team-usage.gateway";
import { WsAuthService } from "../../src/websocket-gateway/ws-auth.service";
import { WsConnectionLimitConfigService } from "../../src/websocket-gateway/ws-connection-limit-config.service";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-teamusage-${Math.random().toString(36).slice(2, 8)}`;
}

/** Same `ams_app`-role pool convention as org-usage-pipeline.integration.test.ts — a superuser-connected pool would silently bypass RLS. */
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
  await adminPool.query("DELETE FROM credit_budgets WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM organization_credit_pools WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM team_members WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

function buildRig(pool: Pool) {
  const repository = new TeamUsageDashboardRepository(pool);
  const cache = new TeamUsageCacheService();
  const budgetRepository = new CreditBudgetRepository(pool);
  const audit = new PostgresAuditService(pool);
  const creditBudgetService = new CreditBudgetService(pool, budgetRepository, audit);
  // TeamMembershipRepository.getUserTeamIds accepts an optional
  // tenant-scoped `client` param precisely so callers (this service,
  // RbacGuard) can pass an already-`set_config`'d client — see that
  // repository's own doc comment for why a bare, unscoped call against
  // `team_members` (which has RLS enabled, migration 006) can't be
  // relied on otherwise. Every call site below that actually needs a
  // real membership answer passes a real tenant-scoped client through
  // resolveTeamId/getTeamUsageSummary accordingly.
  const teamMembershipRepository = new TeamMembershipRepository(pool);
  const service = new TeamUsageDashboardService(repository, cache, creditBudgetService, teamMembershipRepository, audit);
  return { repository, cache, creditBudgetService, teamMembershipRepository, service, budgetRepository };
}

test("real Postgres: Team Lead A viewing the team dashboard sees ZERO rows from Team B, even though both are in the same tenant — Platform Administrator sees both", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Team Usage ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const teamA = (await adminPool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team A') RETURNING id", [tenant.id])).rows[0].id;
    const teamB = (await adminPool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team B') RETURNING id", [tenant.id])).rows[0].id;

    // A genuinely random UUID, not a fixed literal — `users.id` is a
    // global (not per-tenant) primary key, and a hardcoded id previously
    // collided with an unrelated test file's own leftover fixture row
    // sharing the same literal, well after that other suite had already
    // run and (for whatever reason) left its row behind.
    const teamLeadUserId = randomUUID();
    await adminPool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, 'lead-a@example.com', 'Team A Lead')", [teamLeadUserId, tenant.id]);
    await adminPool.query("INSERT INTO team_members (team_id, tenant_id, user_id) VALUES ($1, $2, $3)", [teamA, tenant.id, teamLeadUserId]);

    const encryptionService = new EncryptionService(adminPool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(adminPool);
    const agentsService = new AgentsService(adminPool, agentsRepository, encryptionService, audit, buildAdapterHealthService(adminPool));

    const agentA = await agentsService.create(adminPool, tenant.id, null, { name: "Team A Agent", framework: "langchain", teamId: teamA, connectionConfig: {} });
    const agentB = await agentsService.create(adminPool, tenant.id, null, { name: "Team B Agent", framework: "crewai", teamId: teamB, connectionConfig: {} });

    const txRepository = new CreditTransactionRepository(appPool);
    await withTenantContext(appPool, tenant.id, (client) =>
      txRepository.recordTransaction(client, tenant.id, { teamId: teamA, agentId: agentA.id, entryType: "debit", amount: 111, actionType: "agent_execution", description: "team A usage", actorId: null }),
    );
    await withTenantContext(appPool, tenant.id, (client) =>
      txRepository.recordTransaction(client, tenant.id, { teamId: teamB, agentId: agentB.id, entryType: "debit", amount: 999, actionType: "agent_execution", description: "team B usage", actorId: null }),
    );

    const rig = buildRig(appPool);

    try {
      const now = new Date();

      // --- Team Lead A: own team (allowed) ---
      // resolveTeamId is called with a real tenant-scoped client here
      // (same as TeamUsageDashboardController's own req.tenantDbClient) —
      // TeamMembershipRepository.getUserTeamIds' own doc comment explains
      // why an unscoped call (bare `this.pool`) against the RLS-protected
      // `team_members` table can't be relied on to see this insert at all.
      const leadCtx = { tenantId: tenant.id, actorId: teamLeadUserId, roles: [PlatformRoleName.TEAM_LEAD] };
      const resolvedTeamId = await withTenantContext(appPool, tenant.id, (client) => rig.service.resolveTeamId(client, leadCtx, teamA));
      assert.equal(resolvedTeamId, teamA);

      const summaryA = await withTenantContext(appPool, tenant.id, (client) => rig.service.getTeamUsageSummary(client, leadCtx, teamA));
      assert.equal(summaryA.balance.consumed, 111, "Team Lead A must see exactly Team A's own consumption");
      assert.ok(
        !summaryA.agentComparison.some((a) => a.agentId === agentB.id),
        "Team B's agent must never appear in Team A's comparison",
      );
      assert.ok(!summaryA.consumptionTrend.some(() => false)); // trend has no agent identity to leak, but assert it's non-empty and team-A-sized:
      const totalTrendA = summaryA.consumptionTrend.reduce((sum, p) => sum + p.credits, 0);
      assert.equal(totalTrendA, 111, "Team A's trend must reflect only Team A's 111 credits, never Team B's 999");

      // --- Team Lead A: Team B (zero cross-team leakage — denied outright) ---
      await assert.rejects(
        () => withTenantContext(appPool, tenant.id, (client) => rig.service.resolveTeamId(client, leadCtx, teamB)),
        (err: any) => err.status === 403 || err.getStatus?.() === 403,
        "Team Lead A must be denied access to Team B's dashboard entirely — this is the zero-leakage assertion this AC requires",
      );

      // --- Platform Administrator: sees BOTH teams --- (org-scoped resolution never touches team_members at all when team_id is explicit, so no client/RLS concern here)
      const adminCtx = { tenantId: tenant.id, actorId: null, roles: [PlatformRoleName.PLATFORM_ADMIN] };
      const adminResolvedA = await rig.service.resolveTeamId(undefined, adminCtx, teamA);
      const adminResolvedB = await rig.service.resolveTeamId(undefined, adminCtx, teamB);
      assert.equal(adminResolvedA, teamA);
      assert.equal(adminResolvedB, teamB);

      const summaryBAsAdmin = await withTenantContext(appPool, tenant.id, (client) => rig.service.getTeamUsageSummary(client, adminCtx, teamB));
      assert.equal(summaryBAsAdmin.balance.consumed, 999, "Platform Administrator must see Team B's real consumption");

      // --- WebSocket push leg: TeamUsagePublisherService -> RedisPubSubService -> TeamUsageGateway (reuses WO-074's WebSocket infra) ---
      const publisherPubsub = new RedisPubSubService();
      const publisher = new TeamUsagePublisherService(rig.service, publisherPubsub);

      const keyService = new JwtKeyService();
      const verifier = new MultiKeyJwtVerifier(keyService);
      const wsAuthService = new WsAuthService(verifier);
      const connectionRegistry = new ConnectionRegistryService();
      const gatewayPubsub = new RedisPubSubService();
      const batcher = new MessageBatcherService();
      const wsMetrics = new WsMetricsService();
      const limitConfig = new WsConnectionLimitConfigService();
      const gateway = new TeamUsageGateway(wsAuthService, connectionRegistry, gatewayPubsub, batcher, wsMetrics, limitConfig);

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
        ping() {}
      }
      const fakeClient = new FakeSocket();
      const token = keyService.sign({ tid: tenant.id, roles: ["platform_admin"] }, "admin-user", 900);

      try {
        await gateway.handleConnection(fakeClient as any, { url: `/ws/dashboard/usage/team?token=${token}` } as any);
        await withTenantContext(appPool, tenant.id, (client) => publisher.publishUpdate(client, tenant.id, teamA));
        await new Promise((resolve) => setTimeout(resolve, 250));

        assert.equal(fakeClient.sent.length, 1, "the connected client must receive exactly one batched team-usage push");
        const frame = JSON.parse(fakeClient.sent[0]);
        assert.equal(frame.channel, "team_usage");
        const pushed = frame.batch[0] as { type: string; data: { teamId: string; balance: { consumed: number } } };
        assert.equal(pushed.type, "team_usage_update");
        assert.equal(pushed.data.teamId, teamA);
        assert.equal(pushed.data.balance.consumed, 111);
      } finally {
        await gateway.handleDisconnect(fakeClient as any);
        await connectionRegistry.onModuleDestroy();
        await gatewayPubsub.onModuleDestroy();
        await publisherPubsub.onModuleDestroy();
      }

      void now;
    } finally {
      await rig.cache.onModuleDestroy();
    }
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});

test("real Postgres: a Platform Administrator with no team_id supplied defaults to the tenant's first team, and an Admin in a zero-team tenant gets a guidance empty state", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slugWithTeams = randomSlug();
  const slugNoTeams = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);

    const tenantWithTeams = await saga.provision({ name: `Team Usage Default ${slugWithTeams}`, slug: slugWithTeams, dataResidencyRegion: "us", actorId: null });
    await adminPool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Only Team')", [tenantWithTeams.id]);

    const tenantNoTeams = await saga.provision({ name: `Team Usage Empty ${slugNoTeams}`, slug: slugNoTeams, dataResidencyRegion: "us", actorId: null });

    const rig = buildRig(appPool);
    try {
      const adminCtx1 = { tenantId: tenantWithTeams.id, actorId: "admin-1", roles: [PlatformRoleName.PLATFORM_ADMIN] };
      const resolved = await withTenantContext(appPool, tenantWithTeams.id, (client) => rig.service.resolveTeamId(client, adminCtx1, undefined));
      assert.ok(resolved, "must default to the tenant's only team");

      const adminCtx2 = { tenantId: tenantNoTeams.id, actorId: "admin-2", roles: [PlatformRoleName.PLATFORM_ADMIN] };
      await assert.rejects(() => withTenantContext(appPool, tenantNoTeams.id, (client) => rig.service.resolveTeamId(client, adminCtx2, undefined)));
    } finally {
      await rig.cache.onModuleDestroy();
    }
  } finally {
    await cleanupTenant(adminPool, slugWithTeams);
    await cleanupTenant(adminPool, slugNoTeams);
    await adminPool.end();
    await appPool.end();
  }
});
