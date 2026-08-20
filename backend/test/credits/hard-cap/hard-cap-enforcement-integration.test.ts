import { buildAdapterHealthService } from "../../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentInFlightOperationsService } from "../../../src/agents/agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "../../../src/agents/agent-state-transitions.repository";
import { AgentsRepository } from "../../../src/agents/agents.repository";
import { AgentsService } from "../../../src/agents/agents.service";
import { LifecycleService } from "../../../src/agents/lifecycle.service";
import { AlertDeliveryService } from "../../../src/alerts/alert-delivery.service";
import { AlertEventRepository } from "../../../src/alerts/alert-event.repository";
import { ChannelConfigCacheService } from "../../../src/alerts/channel-config-cache.service";
import { EmailAlertChannelService } from "../../../src/alerts/channels/email-alert-channel.service";
import { WebhookAlertChannelService } from "../../../src/alerts/channels/webhook-alert-channel.service";
import { WebSocketAlertChannelService } from "../../../src/alerts/channels/websocket-alert-channel.service";
import { AlertDeliveryLogRepository } from "../../../src/alerts/alert-delivery-log.repository";
import { EmailChannelConfigRepository } from "../../../src/alerts/email-channel-config.repository";
import { WebhookConfigRepository } from "../../../src/alerts/webhook-config.repository";
import { InMemoryEmailProviderService } from "../../../src/alerts/ports/in-memory/in-memory-email-provider.service";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { CreditBudgetRepository } from "../../../src/credits/budget/credit-budget.repository";
import { CreditBudgetService } from "../../../src/credits/budget/credit-budget.service";
import { CreditLedgerService } from "../../../src/credits/credit-ledger.service";
import { CreditTransactionRepository } from "../../../src/credits/credit-transaction.repository";
import { HardCapEnforcementService } from "../../../src/credits/hard-cap/hard-cap-enforcement.service";
import { HardCapPauseStateRepository } from "../../../src/credits/hard-cap/hard-cap-pause-state.repository";
import { HardCapResumeSchedulerService } from "../../../src/credits/hard-cap/hard-cap-resume.scheduler.service";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { RedisPubSubService } from "../../../src/websocket-gateway/redis-pubsub.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const skip = !DATABASE_URL || !REDIS_URL;

function randomSlug(): string {
  return `test-hardcap-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM hard_cap_pause_state WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM alert_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_state_transitions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_budgets WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM organization_credit_pools WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
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

  const budgetRepository = new CreditBudgetRepository(pool);
  const budgetService = new CreditBudgetService(pool, budgetRepository, audit);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const ledgerService = new CreditLedgerService(ledgerRepository, audit);

  const emailProvider = new InMemoryEmailProviderService();
  const webhookConfigRepository = new WebhookConfigRepository(pool);
  const emailConfigRepository = new EmailChannelConfigRepository(pool);
  const configCache = new ChannelConfigCacheService();
  const deliveryLogRepository = new AlertDeliveryLogRepository(pool);
  const webhookChannel = new WebhookAlertChannelService();
  const websocketChannel = new WebSocketAlertChannelService(pubsub);
  const emailChannel = new EmailAlertChannelService(emailProvider, agentsRepository, new PhiScrubberService());
  const alertEventRepository = new AlertEventRepository(pool);
  const alertDeliveryService = new AlertDeliveryService(
    webhookConfigRepository,
    emailConfigRepository,
    configCache,
    encryptionService,
    deliveryLogRepository,
    websocketChannel,
    webhookChannel,
    emailChannel,
    audit,
  );

  const pauseStateRepository = new HardCapPauseStateRepository(pool);
  const enforcementService = new HardCapEnforcementService(pauseStateRepository, budgetService, agentsRepository, lifecycleService, alertEventRepository, alertDeliveryService);
  const resumeScheduler = new HardCapResumeSchedulerService(pauseStateRepository, enforcementService);

  return { saga, agentsService, lifecycleService, budgetRepository, budgetService, ledgerService, emailProvider, pauseStateRepository, enforcementService, resumeScheduler, pubsub };
}

test("real Postgres+Redis: a team reaching its hard cap has every active agent paused, tracked, and alerted; raising the budget auto-resumes them", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, lifecycleService, budgetRepository, budgetService, ledgerService, pauseStateRepository, enforcementService, resumeScheduler, pubsub } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "Hard Cap Co", slug, dataResidencyRegion: "us", actorId: null });
    const actorId = (await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, 'hardcap-actor@example.com', 'Hard Cap Actor') RETURNING id", [tenant.id])).rows[0].id;
    const teamId = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Hard Cap Team') RETURNING id", [tenant.id])).rows[0].id;

    // Two active agents on the team, one already-paused agent that must be left untouched.
    const agentA = await agentsService.create(pool, tenant.id, actorId, { name: "Agent A", framework: "langchain", teamId, connectionConfig: { apiKey: "x" } });
    const agentB = await agentsService.create(pool, tenant.id, actorId, { name: "Agent B", framework: "langchain", teamId, connectionConfig: { apiKey: "x" } });
    const agentC = await agentsService.create(pool, tenant.id, actorId, { name: "Agent C (manually paused)", framework: "langchain", teamId, connectionConfig: { apiKey: "x" } });
    await lifecycleService.transition(pool, tenant.id, actorId, agentA.id, "active", undefined);
    await lifecycleService.transition(pool, tenant.id, actorId, agentB.id, "active", undefined);
    await lifecycleService.transition(pool, tenant.id, actorId, agentC.id, "active", undefined);
    await lifecycleService.transition(pool, tenant.id, actorId, agentC.id, "paused", "manually paused for an unrelated reason before the hard cap was ever reached");

    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const year = now.getUTCFullYear();
    await budgetRepository.upsertPool(pool, tenant.id, month, year, 5000);
    await budgetService.allocate(tenant.id, actorId, { teamId, allocatedCredits: 1000, alertThreshold75: true, alertThreshold90: true, hardCap: 900, effectiveMonth: month, effectiveYear: year, justification: null });

    // Real usage debits bringing consumption to exactly the hard cap.
    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: agentA.id, entryType: "debit", amount: 900, actionType: "tool_call", description: "usage", actorId: null });

    const outcome = await enforcementService.enforceIfBreached(pool, tenant.id, teamId, month, year);
    assert.deepEqual(outcome.pausedAgentIds.sort(), [agentA.id, agentB.id].sort());

    // Real, persisted agent state.
    const agentsAfterPause = await pool.query("SELECT id, lifecycle_status FROM agents WHERE tenant_id = $1 AND team_id = $2", [tenant.id, teamId]);
    const statusById = new Map(agentsAfterPause.rows.map((r) => [r.id, r.lifecycle_status]));
    assert.equal(statusById.get(agentA.id), "paused");
    assert.equal(statusById.get(agentB.id), "paused");
    assert.equal(statusById.get(agentC.id), "paused", "the manually-paused agent stays paused, but must never be tracked as an auto-pause");

    const pauseRows = await pauseStateRepository.findPausedForTeam(pool, tenant.id, teamId);
    assert.deepEqual(pauseRows.map((r) => r.agentId).sort(), [agentA.id, agentB.id].sort());
    assert.ok(!pauseRows.some((r) => r.agentId === agentC.id), "the manually-paused agent must never appear in hard_cap_pause_state");

    // A real, critical alert_events row per auto-paused agent.
    const alertRows = await pool.query("SELECT agent_id, severity, metric_name FROM alert_events WHERE tenant_id = $1 AND metric_name = 'credit_hard_cap_reached'", [tenant.id]);
    assert.equal(alertRows.rows.length, 2);
    assert.ok(alertRows.rows.every((r) => r.severity === "critical"));

    // Re-running enforcement while still over the cap must not re-pause or duplicate pause-state rows (already-paused agents are excluded by the active-only filter).
    const secondEnforce = await enforcementService.enforceIfBreached(pool, tenant.id, teamId, month, year);
    assert.deepEqual(secondEnforce.pausedAgentIds, []);
    assert.equal((await pauseStateRepository.findPausedForTeam(pool, tenant.id, teamId)).length, 2);

    // A Finance Manager raises the budget well above current consumption.
    await budgetService.allocate(tenant.id, actorId, { teamId, allocatedCredits: 5000, alertThreshold75: true, alertThreshold90: true, hardCap: 5000, effectiveMonth: month, effectiveYear: year, justification: "raising the cap" });

    await resumeScheduler.runTickUnlocked(now);

    const agentsAfterResume = await pool.query("SELECT id, lifecycle_status FROM agents WHERE tenant_id = $1 AND team_id = $2", [tenant.id, teamId]);
    const statusAfterResume = new Map(agentsAfterResume.rows.map((r) => [r.id, r.lifecycle_status]));
    assert.equal(statusAfterResume.get(agentA.id), "active");
    assert.equal(statusAfterResume.get(agentB.id), "active");
    assert.equal(statusAfterResume.get(agentC.id), "paused", "the manually-paused agent must NEVER be auto-resumed — it was never this mechanism's to resume");

    assert.equal((await pauseStateRepository.findPausedForTeam(pool, tenant.id, teamId)).length, 0, "resumed agents must be cleared from pause-state tracking");
  } finally {
    await pubsub.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
