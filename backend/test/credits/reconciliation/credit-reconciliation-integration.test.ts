import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { CreditCacheCircuitBreakerService } from "../../../src/credits/credit-cache-circuit-breaker.service";
import { CreditCacheService } from "../../../src/credits/credit-cache.service";
import { CreditLedgerService } from "../../../src/credits/credit-ledger.service";
import { CreditTransactionRepository } from "../../../src/credits/credit-transaction.repository";
import type { CreditConsumptionEvent } from "../../../src/credits/credit-consumption-kafka-producer.service";
import { CreditConsumptionDlqProducerService } from "../../../src/credits/reconciliation/credit-consumption-dlq-producer.service";
import { CreditProcessedEventRepository } from "../../../src/credits/reconciliation/credit-processed-event.repository";
import { CreditReconciliationService } from "../../../src/credits/reconciliation/credit-reconciliation.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-reconcile-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_processed_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

function makeEvent(overrides: Partial<CreditConsumptionEvent>): CreditConsumptionEvent {
  return {
    eventId: randomUUID(),
    tenantId: "",
    teamId: null,
    agentId: null,
    actionType: "tool_call",
    creditsConsumed: 10,
    enforcementMode: "cache",
    decision: "allowed",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

test("real Postgres+Redis: a batch of genuine cache-path consumption events is reconciled into the real ledger, deduplicated on redelivery, and re-warms the real cache — all within the AC's own 60s window", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const startedAt = Date.now();
  const processedEventRepository = new CreditProcessedEventRepository(pool);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const auditService = new InMemoryAuditService();
  const ledgerService = new CreditLedgerService(ledgerRepository, auditService);
  const cacheService = new CreditCacheService();
  const cacheBreaker = new CreditCacheCircuitBreakerService(cacheService);
  const dlqProducer = new CreditConsumptionDlqProducerService();
  const reconciliationService = new CreditReconciliationService(processedEventRepository, ledgerService, cacheBreaker, dlqProducer);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Reconciliation Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamResult = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "reconciliation-team"]);
    const teamId = teamResult.rows[0].id;

    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "credit", amount: 1000, actionType: "topup", description: "initial grant", actorId: null });
    await ledgerService.refreshBalances(pool);

    // A batch of real fast-path consumption events "consumed" from Kafka (substituting for a real broker — see this WO's own reconciliation-doc note).
    const events = Array.from({ length: 5 }, () => makeEvent({ tenantId: tenant.id, teamId, creditsConsumed: 10 }));
    const result = await reconciliationService.processBatch(pool, events);

    assert.equal(result.processed, 5);
    assert.equal(result.deduplicated, 0);
    assert.equal(result.failed.length, 0);

    const balance = await ledgerService.getBalance(pool, tenant.id, teamId);
    assert.equal(balance.netBalance, 950, "1000 - (5 x 10) — the REAL ledger now reflects every reconciled event");

    const history = await ledgerService.getTransactionHistory(pool, tenant.id, { limit: 100, offset: 0 });
    assert.equal(history.rows.filter((r) => r.actionType === "tool_call").length, 5);

    // The real Redis cache should have been re-warmed to the fresh ledger balance.
    const cachedBalance = await cacheService.getBalance(tenant.id, teamId);
    assert.equal(cachedBalance, 950);

    // Redelivery of the EXACT SAME batch (Kafka's own at-least-once delivery, or a consumer restart mid-batch) must be a genuine no-op — real idempotency, not just a unit-test double.
    const redeliveredResult = await reconciliationService.processBatch(pool, events);
    assert.equal(redeliveredResult.processed, 0);
    assert.equal(redeliveredResult.deduplicated, 5);

    const balanceAfterRedelivery = await ledgerService.getBalance(pool, tenant.id, teamId);
    assert.equal(balanceAfterRedelivery.netBalance, 950, "redelivering the same batch must never double-debit the real ledger");

    const finalHistory = await ledgerService.getTransactionHistory(pool, tenant.id, { limit: 100, offset: 0 });
    assert.equal(finalHistory.rows.filter((r) => r.actionType === "tool_call").length, 5, "still exactly 5 real debits — none duplicated");

    const processedCount = await processedEventRepository.countForTenant(pool, tenant.id);
    assert.equal(processedCount, 5);

    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 60_000, `reconciliation flow took ${elapsedMs}ms, expected under the AC's own 60s window`);
  } finally {
    await cacheService.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: a mixed batch (denied + ledger-mode + genuine cache-mode events) only reconciles the genuine ones, with the real ledger reflecting exactly that", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const processedEventRepository = new CreditProcessedEventRepository(pool);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const auditService = new InMemoryAuditService();
  const ledgerService = new CreditLedgerService(ledgerRepository, auditService);
  const cacheService = new CreditCacheService();
  const cacheBreaker = new CreditCacheCircuitBreakerService(cacheService);
  const dlqProducer = new CreditConsumptionDlqProducerService();
  const reconciliationService = new CreditReconciliationService(processedEventRepository, ledgerService, cacheBreaker, dlqProducer);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Mixed Batch Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamResult = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "mixed-team"]);
    const teamId = teamResult.rows[0].id;

    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "credit", amount: 1000, actionType: "topup", description: "initial grant", actorId: null });

    const events: CreditConsumptionEvent[] = [
      makeEvent({ tenantId: tenant.id, teamId, decision: "denied", creditsConsumed: 50 }), // nothing consumed
      makeEvent({ tenantId: tenant.id, teamId, enforcementMode: "ledger", creditsConsumed: 20 }), // already debited synchronously — must NOT be re-debited
      makeEvent({ tenantId: tenant.id, teamId, creditsConsumed: 15 }), // the one genuine reconciliation target
    ];

    const result = await reconciliationService.processBatch(pool, events);
    assert.equal(result.processed, 1);
    assert.equal(result.skipped, 2);

    const history = await ledgerService.getTransactionHistory(pool, tenant.id, { limit: 100, offset: 0 });
    const reconciliationDebits = history.rows.filter((r) => r.description?.startsWith("reconciliation:"));
    assert.equal(reconciliationDebits.length, 1);
    assert.equal(reconciliationDebits[0].creditsDebit, 15);
  } finally {
    await cacheService.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
