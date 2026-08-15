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
import { CreditLedgerService } from "../../src/credits/credit-ledger.service";
import { CreditTransactionRepository } from "../../src/credits/credit-transaction.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-credits-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenant(pool: Pool, slug: string, name: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  return saga.provision({ name, slug, dataResidencyRegion: "us", actorId: null });
}

test("real Postgres RLS: a tenant's credit balance and transaction history are never visible to a different tenant", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  // ams_app: the least-privilege role RLS actually applies to — the "postgres" superuser bypasses RLS entirely (FORCE ROW LEVEL SECURITY notwithstanding), so testing isolation against it would prove nothing.
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  const appPool = new Pool({ connectionString: appUrl.toString() });

  const slugA = randomSlug();
  const slugB = randomSlug();
  const repository = new CreditTransactionRepository(adminPool);

  try {
    const tenantA = await provisionTenant(adminPool, slugA, "Credits Tenant A");
    const tenantB = await provisionTenant(adminPool, slugB, "Credits Tenant B");

    await repository.recordTransaction(adminPool, tenantA.id, { teamId: null, agentId: null, entryType: "credit", amount: 500, actionType: "topup", description: "initial grant", actorId: null });
    await repository.refreshBalances(adminPool);

    const appClient = await appPool.connect();
    try {
      await appClient.query("SELECT set_config('app.current_tenant', $1, false)", [tenantB.id]);

      const crossTenantHistory = await appClient.query("SELECT * FROM credit_transactions WHERE tenant_id = $1", [tenantA.id]);
      assert.equal(crossTenantHistory.rows.length, 0, "tenant B's connection must never see tenant A's transactions, even when explicitly querying by tenant A's own id");

      const crossTenantBalance = await appClient.query("SELECT * FROM credit_balances_scoped WHERE tenant_id = $1", [tenantA.id]);
      assert.equal(crossTenantBalance.rows.length, 0, "tenant B's connection must never see tenant A's balance");

      await appClient.query("SELECT set_config('app.current_tenant', $1, false)", [tenantA.id]);
      const ownHistory = await appClient.query("SELECT * FROM credit_transactions WHERE tenant_id = $1", [tenantA.id]);
      assert.equal(ownHistory.rows.length, 1, "tenant A's own connection should see its own transaction");
    } finally {
      appClient.release();
    }
  } finally {
    await cleanupTenant(adminPool, slugA);
    await cleanupTenant(adminPool, slugB);
    await appPool.end();
    await adminPool.end();
  }
});

test("real Postgres: concurrent transactions for the SAME (tenant, team) never corrupt the running balance — every row's running_balance equals the true cumulative sum up to it", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new CreditTransactionRepository(pool);
  const auditService = new InMemoryAuditService();
  const service = new CreditLedgerService(repository, auditService);

  try {
    const tenant = await provisionTenant(pool, slug, "Credits Concurrency Tenant");

    // 20 concurrent credits of 10 each, fired at once — genuinely concurrent, not sequential awaits.
    const concurrentCredits = Array.from({ length: 20 }, () => service.recordTransaction(pool, tenant.id, { teamId: null, agentId: null, entryType: "credit", amount: 10, actionType: "usage", description: "concurrent credit", actorId: null }));
    await Promise.all(concurrentCredits);

    const history = await pool.query("SELECT running_balance, credits_credit, credits_debit, created_at, id FROM credit_transactions WHERE tenant_id = $1 ORDER BY created_at ASC, id ASC", [tenant.id]);
    assert.equal(history.rows.length, 20);

    let expectedBalance = 0;
    for (const row of history.rows) {
      expectedBalance += Number(row.credits_credit) - Number(row.credits_debit);
      assert.equal(Number(row.running_balance), expectedBalance, `running_balance at row ${row.id} should equal the true cumulative sum, not a racy/duplicated value`);
    }
    assert.equal(expectedBalance, 200);

    // No two rows should ever land on the same running_balance value (that would indicate two concurrent writers both read the same "prior" balance).
    const balances = history.rows.map((r) => Number(r.running_balance));
    assert.equal(new Set(balances).size, balances.length, "every running_balance value must be unique — a duplicate means the advisory lock failed to serialize concurrent writers");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: getBalance and getTransactionHistory return real, refreshed data end-to-end through CreditLedgerService", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new CreditTransactionRepository(pool);
  const auditService = new InMemoryAuditService();
  const service = new CreditLedgerService(repository, auditService);

  try {
    const tenant = await provisionTenant(pool, slug, "Credits E2E Tenant");

    await service.recordTransaction(pool, tenant.id, { teamId: null, agentId: null, entryType: "credit", amount: 1000, actionType: "topup", description: "grant", actorId: "00000000-0000-0000-0000-0000000000a1" });
    await service.recordTransaction(pool, tenant.id, { teamId: null, agentId: null, entryType: "debit", amount: 150, actionType: "usage", description: "agent run", actorId: null });
    await service.refreshBalances(pool);

    const balance = await service.getBalance(pool, tenant.id, null);
    assert.equal(balance.netBalance, 850);
    assert.equal(balance.transactionCount, 2);

    const history = await service.getTransactionHistory(pool, tenant.id, { limit: 50, offset: 0 });
    assert.equal(history.total, 2);
    assert.equal(history.rows[0].actionType, "usage"); // most recent first
    assert.equal(history.rows[1].actionType, "topup");

    const filtered = await service.getTransactionHistory(pool, tenant.id, { actionType: "usage", limit: 50, offset: 0 });
    assert.equal(filtered.total, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
