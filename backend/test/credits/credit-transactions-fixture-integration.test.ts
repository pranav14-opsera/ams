import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { CreditLedgerService } from "../../src/credits/credit-ledger.service";
import { CreditTransactionRepository } from "../../src/credits/credit-transaction.repository";
import { FIXTURE_TEAM_KEYS, FIXTURE_TENANT_SLUGS, generateCreditTransactionFixtures } from "../fixtures/credit-transactions.fixture";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_transactions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("real Postgres: the committed 1200-transaction/3-tenant/5-team fixture seeds correctly and produces a materialized-view balance matching the real ledger sum, per tenant", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repository = new CreditTransactionRepository(pool);
  const auditService = new InMemoryAuditService();
  const service = new CreditLedgerService(repository, auditService);

  const runSlugs = new Map(FIXTURE_TENANT_SLUGS.map((slug) => [slug, uniqueSlug(slug)]));
  const tenantIdBySlug = new Map<string, string>();
  const teamIdByKey = new Map<string, string>(); // keyed by `${runSlug}:${teamKey}`

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));

    for (const [fixtureSlug, runSlug] of runSlugs) {
      const tenant = await saga.provision({ name: `Fixture ${fixtureSlug}`, slug: runSlug, dataResidencyRegion: "us", actorId: null });
      tenantIdBySlug.set(fixtureSlug, tenant.id);
      for (const teamKey of FIXTURE_TEAM_KEYS) {
        const teamResult = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenant.id, teamKey]);
        teamIdByKey.set(`${runSlug}:${teamKey}`, teamResult.rows[0].id);
      }
    }

    const fixtures = generateCreditTransactionFixtures(1200);
    assert.ok(fixtures.length >= 1000, "AC requires at least 1000 fixture transactions");
    assert.equal(new Set(fixtures.map((f) => f.tenantSlug)).size, 3, "AC requires 3 distinct tenants");
    assert.equal(new Set(fixtures.map((f) => f.teamKey)).size, 5, "AC requires 5 distinct teams");

    const expectedNetByTenant = new Map<string, number>();
    for (const fixture of fixtures) {
      const tenantId = tenantIdBySlug.get(fixture.tenantSlug)!;
      const runSlug = runSlugs.get(fixture.tenantSlug)!;
      const teamId = teamIdByKey.get(`${runSlug}:${fixture.teamKey}`)!;

      await service.recordTransaction(pool, tenantId, {
        teamId,
        agentId: null,
        entryType: fixture.entryType,
        amount: fixture.amount,
        actionType: fixture.actionType,
        description: fixture.description,
        actorId: null,
      });

      const delta = fixture.entryType === "credit" ? fixture.amount : -fixture.amount;
      expectedNetByTenant.set(fixture.tenantSlug, (expectedNetByTenant.get(fixture.tenantSlug) ?? 0) + delta);
    }

    await service.refreshBalances(pool);

    for (const fixtureSlug of FIXTURE_TENANT_SLUGS) {
      const tenantId = tenantIdBySlug.get(fixtureSlug)!;
      const history = await service.getTransactionHistory(pool, tenantId, { limit: 1, offset: 0 });
      const expectedTransactionCount = fixtures.filter((f) => f.tenantSlug === fixtureSlug).length;
      assert.equal(history.total, expectedTransactionCount);

      // Sum across all 5 teams for this tenant should equal the fixture's own expected net.
      let actualNet = 0;
      for (const teamKey of FIXTURE_TEAM_KEYS) {
        const runSlug = runSlugs.get(fixtureSlug)!;
        const teamId = teamIdByKey.get(`${runSlug}:${teamKey}`)!;
        const balance = await service.getBalance(pool, tenantId, teamId);
        actualNet += balance.netBalance;
      }
      assert.equal(actualNet, expectedNetByTenant.get(fixtureSlug), `tenant ${fixtureSlug}'s real materialized-view balance sum should match the fixture's own expected net`);
    }
  } finally {
    for (const runSlug of runSlugs.values()) {
      await cleanupTenant(pool, runSlug);
    }
    await pool.end();
  }
});
