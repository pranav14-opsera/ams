import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { CreditCacheService } from "../../src/credits/credit-cache.service";
import { CreditRateMappingRepository } from "../../src/credits/credit-rate-mapping.repository";
import { CreditRateMappingService } from "../../src/credits/credit-rate-mapping.service";
import { FIXTURE_RATE_TENANT_SLUGS, generateCachedBalanceFixtures, generateRateMappingFixtures } from "../fixtures/credit-rate-mappings.fixture";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM credit_rate_mappings WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("real Postgres+Redis: the committed rate-mapping fixture (5 actions x 3 tenants) and cached-balance fixture seed and read back correctly end-to-end", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const rateRepository = new CreditRateMappingRepository(pool);
  const rateService = new CreditRateMappingService(rateRepository);
  const cacheService = new CreditCacheService();

  const runSlugs = new Map(FIXTURE_RATE_TENANT_SLUGS.map((slug) => [slug, uniqueSlug(slug)]));
  const tenantIdBySlug = new Map<string, string>();

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    for (const [fixtureSlug, runSlug] of runSlugs) {
      const tenant = await saga.provision({ name: `Rate Fixture ${fixtureSlug}`, slug: runSlug, dataResidencyRegion: "us", actorId: null });
      tenantIdBySlug.set(fixtureSlug, tenant.id);
    }

    const rateFixtures = generateRateMappingFixtures();
    assert.equal(rateFixtures.length, 15, "5 action types x 3 tenants");
    assert.equal(new Set(rateFixtures.map((f) => f.actionType)).size, 5);
    assert.equal(new Set(rateFixtures.map((f) => f.tenantSlug)).size, 3);

    for (const fixture of rateFixtures) {
      const tenantId = tenantIdBySlug.get(fixture.tenantSlug)!;
      await rateService.setRate(pool, tenantId, fixture.actionType, fixture.creditsPerUnit);
    }

    for (const fixture of rateFixtures) {
      const tenantId = tenantIdBySlug.get(fixture.tenantSlug)!;
      const rate = await rateService.getRate(pool, tenantId, fixture.actionType);
      assert.equal(rate, fixture.creditsPerUnit, `${fixture.tenantSlug}/${fixture.actionType} should read back its own fixture rate, not another tenant's`);
    }

    const balanceFixtures = generateCachedBalanceFixtures();
    assert.equal(balanceFixtures.length, 15, "5 teams x 3 tenants");
    for (const fixture of balanceFixtures) {
      const tenantId = tenantIdBySlug.get(fixture.tenantSlug)!;
      await cacheService.warmCache(tenantId, fixture.teamKey, fixture.balance);
    }
    for (const fixture of balanceFixtures) {
      const tenantId = tenantIdBySlug.get(fixture.tenantSlug)!;
      const balance = await cacheService.getBalance(tenantId, fixture.teamKey);
      assert.equal(balance, fixture.balance);
      await cacheService.invalidateBalance(tenantId, fixture.teamKey);
    }
  } finally {
    await cacheService.onModuleDestroy();
    await rateService.onModuleDestroy();
    for (const runSlug of runSlugs.values()) {
      await cleanupTenant(pool, runSlug);
    }
    await pool.end();
  }
});
