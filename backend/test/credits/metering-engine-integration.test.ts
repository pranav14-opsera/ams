import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import { CreditCacheCircuitBreakerService } from "../../src/credits/credit-cache-circuit-breaker.service";
import { CreditCacheService } from "../../src/credits/credit-cache.service";
import { CreditLedgerService } from "../../src/credits/credit-ledger.service";
import { CreditRateMappingRepository } from "../../src/credits/credit-rate-mapping.repository";
import { CreditRateMappingService } from "../../src/credits/credit-rate-mapping.service";
import { CreditTransactionRepository } from "../../src/credits/credit-transaction.repository";
import { MeteringEngineService } from "../../src/credits/metering-engine.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-metering-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_rate_mappings WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM team_credit_limits WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

class NullKafkaProducer {
  public published: unknown[] = [];
  async publish(event: unknown) {
    this.published.push(event);
  }
}

test("real Postgres+Redis: end-to-end metering — configure a rate, warm the cache from a real ledger balance, consume via the fast cache path, then force a near-hard-cap fallthrough to a real ledger debit", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const rateRepository = new CreditRateMappingRepository(pool);
  const rateService = new CreditRateMappingService(rateRepository);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const auditService = new InMemoryAuditService();
  const ledgerService = new CreditLedgerService(ledgerRepository, auditService);
  const cacheService = new CreditCacheService();
  const cacheBreaker = new CreditCacheCircuitBreakerService(cacheService);
  const kafkaProducer = new NullKafkaProducer();
  const engine = new MeteringEngineService(rateService, cacheBreaker, ledgerService, kafkaProducer as any);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Metering Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamResult = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "metering-team"]);
    const teamId = teamResult.rows[0].id;

    await rateService.setRate(pool, tenant.id, "tool_call", 10);
    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "credit", amount: 1000, actionType: "topup", description: "initial grant", actorId: null });
    await ledgerService.refreshBalances(pool); // credit_balances is a materialized view — must be refreshed before getBalance (the cache-miss warming path) reflects the topup.

    // First check: cache miss (nothing warmed yet) -> warms from the real ledger balance (1000), then allows via the fast cache path.
    const first = await engine.checkAndConsume({ tenantId: tenant.id, teamId, agentId: null, actionType: "tool_call" });
    assert.equal(first.decision, "allowed");
    assert.equal(first.creditsConsumed, 10);
    assert.equal(first.balanceAfter, 990);
    assert.equal(kafkaProducer.published.length, 1);

    // Second check: cache is warm now, still well clear of any hard cap (none configured) -> fast cache path again.
    const second = await engine.checkAndConsume({ tenantId: tenant.id, teamId, agentId: null, actionType: "tool_call" });
    assert.equal(second.decision, "allowed");
    assert.equal(second.enforcementMode, "cache");
    assert.equal(second.balanceAfter, 980);

    // Now configure a hard cap of 200 (5% buffer = 10) and directly warm the cache to a deliberately STALE, fake value of 15 — a projected post-cost balance of 5, inside that 10-wide buffer — to deterministically force the near-cap fallthrough and prove the real ledger (980), not this fake cached value, is what actually governs the outcome.
    await rateService.setHardCap(pool, tenant.id, teamId, 200);
    await cacheService.warmCache(tenant.id, teamId, 15);

    const nearCapCheck = await engine.checkAndConsume({ tenantId: tenant.id, teamId, agentId: null, actionType: "tool_call" });
    assert.equal(nearCapCheck.enforcementMode, "ledger", "a projected balance within the hard cap's 5% buffer must fall through to a real, synchronous ledger check");
    assert.equal(nearCapCheck.decision, "allowed");

    await ledgerService.refreshBalances(pool);
    const realBalance = await ledgerService.getBalance(pool, tenant.id, teamId);
    assert.equal(realBalance.netBalance, nearCapCheck.balanceAfter, "the ledger fallthrough's reported balance must match the REAL ledger, not the stale cached approximation (15)");
    // The fast cache path (the first two checks above) intentionally never touches the real ledger at all — per this WO's own "hybrid consistency model", Redis runs ahead of the authoritative ledger until WO-067's async reconciliation catches it up. So the real ledger here still only reflects the 1000-credit topup, minus THIS ONE fallthrough debit — not the two fast-path decrements, which so far exist only in Redis.
    assert.equal(nearCapCheck.balanceAfter, 990, "the real ledger balance (1000 from the topup, untouched by the two Redis-only fast-path decrements) minus this fallthrough's own 10-credit debit");

    const history = await ledgerService.getTransactionHistory(pool, tenant.id, { limit: 100, offset: 0 });
    assert.equal(history.rows.filter((r) => r.actionType === "tool_call").length, 1, "only the ledger-fallthrough check produces a real credit_transactions row — the two fast-path decrements are Redis-only until reconciliation");
  } finally {
    await cacheService.onModuleDestroy();
    await rateService.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres+Redis: an insufficient real balance is genuinely denied through the ledger fallthrough, with no debit recorded", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const rateRepository = new CreditRateMappingRepository(pool);
  const rateService = new CreditRateMappingService(rateRepository);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const auditService = new InMemoryAuditService();
  const ledgerService = new CreditLedgerService(ledgerRepository, auditService);
  const cacheService = new CreditCacheService();
  const cacheBreaker = new CreditCacheCircuitBreakerService(cacheService);
  const kafkaProducer = new NullKafkaProducer();
  const engine = new MeteringEngineService(rateService, cacheBreaker, ledgerService, kafkaProducer as any);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Metering Deny Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamResult = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "metering-team"]);
    const teamId = teamResult.rows[0].id;

    await rateService.setRate(pool, tenant.id, "expensive_action", 100);
    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "credit", amount: 50, actionType: "topup", description: "small grant", actorId: null });
    await ledgerService.refreshBalances(pool);
    // A hard cap forces the near-cap fallthrough to the real ledger for this check, so this test genuinely exercises "fallthrough to ledger deny", not a cache-only deny.
    await rateService.setHardCap(pool, tenant.id, teamId, 1000);

    const result = await engine.checkAndConsume({ tenantId: tenant.id, teamId, agentId: null, actionType: "expensive_action" });
    assert.equal(result.enforcementMode, "ledger");
    assert.equal(result.decision, "denied");
    assert.equal(result.creditsConsumed, 100);

    const history = await ledgerService.getTransactionHistory(pool, tenant.id, { limit: 100, offset: 0 });
    assert.equal(history.total, 1, "only the original topup should exist — the denied metering attempt must never have recorded a debit");
  } finally {
    await cacheService.onModuleDestroy();
    await rateService.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
