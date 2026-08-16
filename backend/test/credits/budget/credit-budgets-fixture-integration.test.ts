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
import { FIXTURE_BUDGET_TENANT_SLUGS, generateOrganizationPoolFixtures, generateTeamBudgetFixtures } from "../../fixtures/credit-budgets.fixture";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_budgets WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM organization_credit_pools WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("real Postgres: the committed organization-pool and team-budget fixtures (3 tenants, varying pool sizes) seed and validate correctly end-to-end", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repository = new CreditBudgetRepository(pool);
  const auditService = new InMemoryAuditService();
  const service = new CreditBudgetService(pool, repository, auditService);

  const runSlugs = new Map(FIXTURE_BUDGET_TENANT_SLUGS.map((slug) => [slug, uniqueSlug(slug)]));
  const tenantIdBySlug = new Map<string, string>();
  const teamIdByKey = new Map<string, string>();

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));

    for (const [fixtureSlug, runSlug] of runSlugs) {
      const tenant = await saga.provision({ name: `Budget Fixture ${fixtureSlug}`, slug: runSlug, dataResidencyRegion: "us", actorId: null });
      tenantIdBySlug.set(fixtureSlug, tenant.id);
    }

    const poolFixtures = generateOrganizationPoolFixtures();
    assert.equal(poolFixtures.length, 3);
    assert.equal(new Set(poolFixtures.map((f) => f.totalCredits)).size, 3, "AC requires varying pool sizes across the 3 tenants");
    for (const fixture of poolFixtures) {
      await repository.upsertPool(pool, tenantIdBySlug.get(fixture.tenantSlug)!, 8, 2026, fixture.totalCredits);
    }

    const budgetFixtures = generateTeamBudgetFixtures();
    for (const fixture of budgetFixtures) {
      const tenantId = tenantIdBySlug.get(fixture.tenantSlug)!;
      const key = `${fixture.tenantSlug}:${fixture.teamKey}`;
      if (!teamIdByKey.has(key)) {
        const teamId = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenantId, fixture.teamKey])).rows[0].id;
        teamIdByKey.set(key, teamId);
      }
      const teamId = teamIdByKey.get(key)!;
      const budget = await service.allocate(tenantId, null, {
        teamId,
        allocatedCredits: fixture.allocatedCredits,
        alertThreshold75: fixture.alertThreshold75,
        alertThreshold90: fixture.alertThreshold90,
        hardCap: null,
        effectiveMonth: 8,
        effectiveYear: 2026,
        justification: null,
      });
      assert.equal(budget.allocatedCredits, fixture.allocatedCredits);
    }

    // Each tenant's own fixture budgets should fit within its own fixture pool — verify by re-reading through the real service.
    for (const fixtureSlug of FIXTURE_BUDGET_TENANT_SLUGS) {
      const tenantId = tenantIdBySlug.get(fixtureSlug)!;
      const budgets = await service.listBudgets(pool, tenantId, 8, 2026);
      const expectedCount = budgetFixtures.filter((f) => f.tenantSlug === fixtureSlug).length;
      assert.equal(budgets.length, expectedCount);

      const totalAllocated = budgets.reduce((sum, b) => sum + b.allocatedCredits, 0);
      const poolFixture = poolFixtures.find((p) => p.tenantSlug === fixtureSlug)!;
      assert.ok(totalAllocated <= poolFixture.totalCredits, `${fixtureSlug}'s fixture allocations (${totalAllocated}) must fit within its own fixture pool (${poolFixture.totalCredits})`);
    }
  } finally {
    for (const runSlug of runSlugs.values()) {
      await cleanupTenant(pool, runSlug);
    }
    await pool.end();
  }
});
