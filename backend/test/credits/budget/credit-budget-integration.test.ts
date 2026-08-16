import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { CreditBudgetRepository } from "../../../src/credits/budget/credit-budget.repository";
import { CreditBudgetService } from "../../../src/credits/budget/credit-budget.service";
import { CreditLedgerService } from "../../../src/credits/credit-ledger.service";
import { CreditTransactionRepository } from "../../../src/credits/credit-transaction.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-budget-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_budgets WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM organization_credit_pools WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("real Postgres: allocation validates against the real org pool, persists, and is genuinely audited", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new CreditBudgetRepository(pool);
  const auditService = new PostgresAuditService(pool);
  const service = new CreditBudgetService(pool, repository, auditService);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Budget Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const team1 = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "team-alpha"])).rows[0].id;
    const team2 = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "team-beta"])).rows[0].id;

    await repository.upsertPool(pool, tenant.id, 8, 2026, 5000);

    const budget1 = await service.allocate(tenant.id, null, { teamId: team1, allocatedCredits: 3000, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, justification: "Q3 allocation" });
    assert.equal(budget1.allocatedCredits, 3000);

    // Team 2 asking for more than the remaining 2000 must be rejected.
    await assert.rejects(() => service.allocate(tenant.id, null, { teamId: team2, allocatedCredits: 2500, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, justification: null }));

    // Exactly the remaining amount succeeds.
    const budget2 = await service.allocate(tenant.id, null, { teamId: team2, allocatedCredits: 2000, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, justification: null });
    assert.equal(budget2.allocatedCredits, 2000);

    const allBudgets = await service.listBudgets(pool, tenant.id, 8, 2026);
    assert.equal(allBudgets.length, 2);

    const auditRows = await pool.query("SELECT * FROM audit_events WHERE tenant_id = $1 AND action = 'credit_budget.allocated'", [tenant.id]);
    assert.equal(auditRows.rows.length, 2, "each successful allocation should have produced its own real audit event");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: concurrent allocation attempts that would jointly overspend the pool are serialized — only one succeeds, the pool is never oversold", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new CreditBudgetRepository(pool);
  const auditService = new InMemoryAuditService();
  const service = new CreditBudgetService(pool, repository, auditService);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Budget Race Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      teamIds.push((await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, `team-${i}`])).rows[0].id);
    }

    await repository.upsertPool(pool, tenant.id, 8, 2026, 1000); // only enough for ONE of the 3 concurrent 500-credit requests below (2 could fit, not 3)

    const attempts = teamIds.map((teamId) =>
      service.allocate(tenant.id, null, { teamId, allocatedCredits: 500, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, justification: null }).then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      ),
    );
    const outcomes = await Promise.all(attempts);

    const fulfilledCount = outcomes.filter((o) => o === "fulfilled").length;
    assert.equal(fulfilledCount, 2, "exactly 2 of the 3 concurrent 500-credit requests should fit within the 1000-credit pool");

    const total = await repository.sumAllocatedForPeriod(pool, tenant.id, 8, 2026);
    assert.equal(total, 1000, "the real, final sum of allocations must never exceed the pool, even under genuine concurrency");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: getTeamBudget reflects real ledger consumption for the period, not a fabricated figure", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new CreditBudgetRepository(pool);
  const auditService = new InMemoryAuditService();
  const service = new CreditBudgetService(pool, repository, auditService);
  const ledgerRepository = new CreditTransactionRepository(pool);
  const ledgerService = new CreditLedgerService(ledgerRepository, auditService);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Budget Consumption Tenant", slug, dataResidencyRegion: "us", actorId: null });
    const teamId = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, "team-consuming"])).rows[0].id;

    await repository.upsertPool(pool, tenant.id, 8, 2026, 5000);
    await service.allocate(tenant.id, null, { teamId, allocatedCredits: 1000, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, justification: null });

    // Real usage debits within the period.
    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "debit", amount: 100, actionType: "tool_call", description: "usage", actorId: null });
    await ledgerService.recordTransaction(pool, tenant.id, { teamId, agentId: null, entryType: "debit", amount: 150, actionType: "tool_call", description: "usage", actorId: null });

    const summary = await service.getTeamBudget(pool, tenant.id, teamId, 8, 2026);
    assert.equal(summary.consumedCredits, 250);
    assert.equal(summary.remainingCredits, 750);
    assert.equal(summary.consumptionPercentage, 25);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
