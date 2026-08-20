import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { OnboardingProgressRepository } from "../../src/onboarding/onboarding-progress.repository";
import { OnboardingService } from "../../src/onboarding/onboarding.service";
import { CreditBudgetRepository } from "../../src/credits/budget/credit-budget.repository";
import { CreditBudgetService } from "../../src/credits/budget/credit-budget.service";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-onboarding-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM onboarding_progress WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM credit_budgets WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM organization_credit_pools WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM group_role_mappings WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenant_sso_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenant(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  return saga.provision({ name: "Onboarding Tenant", slug, dataResidencyRegion: "us", actorId: null });
}

test("real Postgres: saveProgress persists steps, redacts secrets, and merges completed_steps across calls", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new OnboardingProgressRepository();
  const service = new OnboardingService(repository, new PostgresAuditService(pool));

  try {
    const tenant = await provisionTenant(pool, slug);

    await service.saveProgress(pool, tenant.id, null, 1, { step1: { orgName: "Acme Health", region: "us" } }, [1]);
    const afterStep1 = await service.saveProgress(
      pool,
      tenant.id,
      null,
      2,
      { step2: { protocol: "oidc", oidcClientId: "client-123", oidcClientSecret: "super-secret-value" } },
      [1, 2],
    );

    assert.deepEqual(afterStep1.completedSteps, [1, 2]);
    assert.equal(afterStep1.currentStep, 2);
    // Step 1's data survives a Step 2 save (JSONB merge, not overwrite).
    assert.equal((afterStep1.stepData as any).step1.orgName, "Acme Health");
    // The raw secret must NEVER reach the persisted row.
    assert.equal((afterStep1.stepData as any).step2.oidcClientSecret, "__redacted__");
    assert.equal((afterStep1.stepData as any).step2.oidcClientId, "client-123");

    const rawRow = await pool.query("SELECT step_data::text AS text FROM onboarding_progress WHERE tenant_id = $1", [tenant.id]);
    assert.ok(!rawRow.rows[0].text.includes("super-secret-value"), "the raw secret must never be written to the database at all");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: getProgress returns expired:true once past the 7-day window, without throwing", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new OnboardingProgressRepository();
  const service = new OnboardingService(repository, new PostgresAuditService(pool));

  try {
    const tenant = await provisionTenant(pool, slug);
    await service.saveProgress(pool, tenant.id, null, 1, { step1: {} }, [1]);

    // Force the row into the past, as if it had been sitting untouched for 8 days.
    await pool.query("UPDATE onboarding_progress SET expires_at = now() - interval '1 day' WHERE tenant_id = $1", [tenant.id]);

    const result = await service.getProgress(pool, tenant.id);
    assert.ok(result);
    assert.equal(result!.expired, true);

    // edge_case: restart clears the stale row so a fresh one can be created.
    await service.restart(pool, tenant.id);
    const afterRestart = await service.getProgress(pool, tenant.id);
    assert.equal(afterRestart, null);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: getStatus reflects mixed pass/fail state computed from real rows written by the earlier steps", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const repository = new OnboardingProgressRepository();
  const service = new OnboardingService(repository, new PostgresAuditService(pool));
  const creditBudgetRepository = new CreditBudgetRepository(pool);
  const creditBudgetService = new CreditBudgetService(pool, creditBudgetRepository, new PostgresAuditService(pool));

  try {
    const tenant = await provisionTenant(pool, slug);

    // Nothing configured yet: every check should fail.
    const beforeStatus = await service.getStatus(pool, tenant.id);
    assert.equal(beforeStatus.allPassed, false);
    assert.ok(beforeStatus.checks.every((c) => c.status === "fail"));

    // Configure SSO (real row, same shape SsoConfigController writes).
    await pool.query(
      "INSERT INTO tenant_sso_configs (tenant_id, protocol, oidc_discovery_url, oidc_client_id) VALUES ($1, 'oidc', 'https://idp.example.com/.well-known/openid-configuration', 'client-abc')",
      [tenant.id],
    );

    // Group-to-role mapping (real row via the same table GroupMappingController writes).
    await pool.query(
      "INSERT INTO group_role_mappings (tenant_id, idp_group, platform_role, priority) VALUES ($1, 'Engineering', 'platform_admin', 0)",
      [tenant.id],
    );

    // An active agent (real row, same shape agent registration produces once connection validation succeeds).
    const teamId = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team A') RETURNING id", [tenant.id])).rows[0].id;
    await pool.query(
      `INSERT INTO agents (
         tenant_id, team_id, name, framework, lifecycle_status,
         connection_config_ciphertext, connection_config_iv, connection_config_auth_tag, connection_config_encrypted_dek, connection_config_key_version,
         hmac_secret_ciphertext, hmac_secret_iv, hmac_secret_auth_tag, hmac_secret_encrypted_dek, hmac_secret_key_version
       )
       VALUES ($1, $2, 'Agent 1', 'generic_rest', 'active', ''::bytea, ''::bytea, ''::bytea, ''::bytea, 0, ''::bytea, ''::bytea, ''::bytea, ''::bytea, 0)`,
      [tenant.id, teamId],
    );

    // Credit budget for the CURRENT period (what the checkCreditBudget query filters on).
    const now = new Date();
    await creditBudgetRepository.upsertPool(pool, tenant.id, now.getUTCMonth() + 1, now.getUTCFullYear(), 1000);
    await creditBudgetService.allocate(tenant.id, null, {
      teamId,
      allocatedCredits: 500,
      alertThreshold75: true,
      alertThreshold90: true,
      hardCap: null,
      effectiveMonth: now.getUTCMonth() + 1,
      effectiveYear: now.getUTCFullYear(),
      justification: null,
    });

    const afterStatus = await service.getStatus(pool, tenant.id);
    assert.equal(afterStatus.allPassed, true, JSON.stringify(afterStatus.checks));
    assert.ok(afterStatus.checks.every((c) => c.status === "pass"));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
