import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { CreditBudgetController } from "../../../src/credits/budget/credit-budget.controller";
import { CreditBudgetRepository } from "../../../src/credits/budget/credit-budget.repository";
import { CreditBudgetService } from "../../../src/credits/budget/credit-budget.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-credit-pool-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM organization_credit_pools WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

// WO-082 Step 5: onboarding needs to provision the org's own credit pool
// before allocate() will accept anything against it — this is the new
// POST /api/v1/credits/pool route's own controller-level test.
test("real Postgres: POST /api/v1/credits/pool provisions the pool and is idempotent (a re-run tops it up rather than erroring)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new CreditBudgetRepository(pool);
  const auditService = new PostgresAuditService(pool);
  const service = new CreditBudgetService(pool, repository, auditService);
  const controller = new CreditBudgetController(service);

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: "Credit Pool Tenant", slug, dataResidencyRegion: "us", actorId: null });

    const req = { tenantId: tenant.id, actorId: null } as any;
    const pool1 = await controller.upsertPool({ totalCredits: 10_000, effectiveMonth: 8, effectiveYear: 2026 }, req);
    assert.equal(pool1.totalCredits, 10_000);

    const pool2 = await controller.upsertPool({ totalCredits: 15_000, effectiveMonth: 8, effectiveYear: 2026 }, req);
    assert.equal(pool2.totalCredits, 15_000);
    assert.equal(pool2.id, pool1.id, "same tenant+period should update the same row, not create a second one");

    const auditRows = await pool.query("SELECT * FROM audit_events WHERE tenant_id = $1 AND action = 'credit_budget.pool_allocated'", [tenant.id]);
    assert.equal(auditRows.rows.length, 2);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
