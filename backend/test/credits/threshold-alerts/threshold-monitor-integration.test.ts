import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { InMemoryEmailProviderService } from "../../../src/alerts/ports/in-memory/in-memory-email-provider.service";
import { WebhookAlertChannelService } from "../../../src/alerts/channels/webhook-alert-channel.service";
import { WebhookConfigRepository } from "../../../src/alerts/webhook-config.repository";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { RedisPubSubService } from "../../../src/websocket-gateway/redis-pubsub.service";
import { CreditBudgetRepository } from "../../../src/credits/budget/credit-budget.repository";
import { CreditBudgetService } from "../../../src/credits/budget/credit-budget.service";
import { CreditLedgerService } from "../../../src/credits/credit-ledger.service";
import { CreditTransactionRepository } from "../../../src/credits/credit-transaction.repository";
import { CreditThresholdAlertDeliveryService } from "../../../src/credits/threshold-alerts/credit-threshold-alert-delivery.service";
import { CreditThresholdAlertRepository } from "../../../src/credits/threshold-alerts/credit-threshold-alert.repository";
import { ThresholdMonitorService } from "../../../src/credits/threshold-alerts/threshold-monitor.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-threshold-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_alerts WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_budgets WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM organization_credit_pools WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM team_members WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("real Postgres+Redis: a team crossing 75% of its real allocated budget generates exactly one real, deduplicated alert, emailed to its real team lead + finance manager", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const budgetRepository = new CreditBudgetRepository(pool);
  const auditService = new InMemoryAuditService();
  const budgetService = new CreditBudgetService(pool, budgetRepository, auditService);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const ledgerService = new CreditLedgerService(ledgerRepository, auditService);

  const alertRepository = new CreditThresholdAlertRepository(pool);
  const emailProvider = new InMemoryEmailProviderService();
  const webhookConfigRepository = new WebhookConfigRepository(pool);
  const kms = new InMemoryKmsService();
  const tenantKeyMetadataRepository = new TenantKeyMetadataRepository();
  const encryptionService = new EncryptionService(pool, kms, tenantKeyMetadataRepository, new PostgresAuditService(pool));
  const webhookChannel = new WebhookAlertChannelService();
  const pubsub = new RedisPubSubService();
  const deliveryService = new CreditThresholdAlertDeliveryService(emailProvider, webhookConfigRepository, encryptionService, webhookChannel, pubsub);
  const monitorService = new ThresholdMonitorService(budgetService, alertRepository, deliveryService);

  try {
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), tenantKeyMetadataRepository, kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Threshold Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamId = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "Team Alpha"])).rows[0].id;

    const teamLeadId = "11111111-1111-1111-1111-111111111111";
    const financeManagerId = "22222222-2222-2222-2222-222222222222";
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name, role) VALUES ($1, $2, 'lead@example.com', 'Team Lead', 'team_lead')", [teamLeadId, tenant.id]);
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name, role) VALUES ($1, $2, 'finance@example.com', 'Finance Manager', 'finance_manager')", [financeManagerId, tenant.id]);
    await pool.query("INSERT INTO team_members (team_id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'lead')", [teamId, tenant.id, teamLeadId]);

    await budgetRepository.upsertPool(pool, tenant.id, 8, 2026, 5000);
    await budgetService.allocate(tenant.id, null, { teamId, allocatedCredits: 1000, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, justification: null });

    // Real usage debits bringing consumption to exactly 76% (crosses 75%, not yet 90%).
    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "debit", amount: 760, actionType: "tool_call", description: "usage", actorId: null });

    const generated = await monitorService.evaluateThresholds(pool, tenant.id, [teamId], 8, 2026);
    assert.equal(generated.length, 1);
    assert.equal(generated[0].thresholdLevel, 75);

    // A real, persisted credit_alerts row.
    const alertRows = await pool.query("SELECT * FROM credit_alerts WHERE tenant_id = $1 AND team_id = $2", [tenant.id, teamId]);
    assert.equal(alertRows.rows.length, 1);
    assert.equal(alertRows.rows[0].threshold_level, 75);

    // A real email, to the real team lead AND finance manager.
    assert.equal(emailProvider.sent.length, 1);
    assert.deepEqual(emailProvider.sent[0].to.sort(), ["finance@example.com", "lead@example.com"]);
    assert.ok(emailProvider.sent[0].subject.includes("75%"));
    assert.ok(emailProvider.sent[0].html.includes("Team Alpha"));

    // Re-evaluating the SAME period must be a genuine no-op — no duplicate row, no duplicate email.
    const secondPass = await monitorService.evaluateThresholds(pool, tenant.id, [teamId], 8, 2026);
    assert.equal(secondPass.length, 0);
    const alertRowsAfter = await pool.query("SELECT * FROM credit_alerts WHERE tenant_id = $1 AND team_id = $2", [tenant.id, teamId]);
    assert.equal(alertRowsAfter.rows.length, 1, "the unique index must prevent a genuine duplicate row");
    assert.equal(emailProvider.sent.length, 1, "no duplicate email on re-evaluation");
  } finally {
    await pubsub.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres+Redis: crossing 90% in one step generates BOTH the 75% and 90% alerts, each with its own real, distinct email", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const budgetRepository = new CreditBudgetRepository(pool);
  const auditService = new InMemoryAuditService();
  const budgetService = new CreditBudgetService(pool, budgetRepository, auditService);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const ledgerService = new CreditLedgerService(ledgerRepository, auditService);

  const alertRepository = new CreditThresholdAlertRepository(pool);
  const emailProvider = new InMemoryEmailProviderService();
  const webhookConfigRepository = new WebhookConfigRepository(pool);
  const kms = new InMemoryKmsService();
  const tenantKeyMetadataRepository = new TenantKeyMetadataRepository();
  const encryptionService = new EncryptionService(pool, kms, tenantKeyMetadataRepository, new PostgresAuditService(pool));
  const webhookChannel = new WebhookAlertChannelService();
  const pubsub = new RedisPubSubService();
  const deliveryService = new CreditThresholdAlertDeliveryService(emailProvider, webhookConfigRepository, encryptionService, webhookChannel, pubsub);
  const monitorService = new ThresholdMonitorService(budgetService, alertRepository, deliveryService);

  try {
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), tenantKeyMetadataRepository, kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Threshold Double Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamId = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "Team Beta"])).rows[0].id;
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name, role) VALUES ($1, $2, 'finance2@example.com', 'Finance Manager 2', 'finance_manager')", ["33333333-3333-3333-3333-333333333333", tenant.id]);

    await budgetRepository.upsertPool(pool, tenant.id, 8, 2026, 5000);
    await budgetService.allocate(tenant.id, null, { teamId, allocatedCredits: 1000, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, justification: null });
    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "debit", amount: 950, actionType: "tool_call", description: "usage", actorId: null }); // 95% in one jump

    const generated = await monitorService.evaluateThresholds(pool, tenant.id, [teamId], 8, 2026);
    assert.deepEqual(generated.map((a) => a.thresholdLevel).sort(), [75, 90]);

    const alertRows = await pool.query("SELECT threshold_level FROM credit_alerts WHERE tenant_id = $1 AND team_id = $2 ORDER BY threshold_level", [tenant.id, teamId]);
    assert.deepEqual(alertRows.rows.map((r) => r.threshold_level), [75, 90]);

    assert.equal(emailProvider.sent.length, 2, "two distinct real emails — one per threshold level");
    assert.ok(emailProvider.sent.some((m) => m.subject.includes("75%")));
    assert.ok(emailProvider.sent.some((m) => m.subject.includes("90%") || m.subject.includes("URGENT")));
  } finally {
    await pubsub.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
