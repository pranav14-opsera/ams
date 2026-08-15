import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";

// End-to-end system integration test (acceptance criteria: "API call
// creates tenant, RLS is active, context middleware injects tenant_id,
// and queries are tenant-scoped... against a real PostgreSQL instance").
// No Docker/testcontainers in this environment — connects to a real
// local Postgres directly, same as the rest of this test suite and
// database/tests/test_rls_isolation.sh.
const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-rls-${Math.random().toString(36).slice(2, 10)}`;
}

test("a tenant provisioned via the saga is genuinely RLS-isolated from another tenant's data", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  // ams_app: the least-privilege role RLS actually applies to — the
  // "postgres" superuser bypasses RLS entirely, so testing isolation
  // against it would prove nothing.
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  const appPool = new Pool({ connectionString: appUrl.toString() });

  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(adminPool);
  const rbac = new PostgresRbacService(adminPool);
  const saga = new TenantProvisioningSaga(adminPool, repo, keyMetadataRepo, kms, rbac, audit);

  const slugA = randomSlug();
  const slugB = randomSlug();

  try {
    const tenantA = await saga.provision({ name: "Tenant A", slug: slugA, dataResidencyRegion: "us", actorId: null });
    const tenantB = await saga.provision({ name: "Tenant B", slug: slugB, dataResidencyRegion: "us", actorId: null });

    // Real data for tenant A only — inserted as the admin connection
    // (RLS doesn't block INSERT with an explicit tenant_id; it's the
    // read path this test is actually about).
    // connection_config_*/hmac_secret_* (WO-031/WO-034): NOT NULL
    // BYOK-encrypted columns — dummy placeholder bytes are fine here,
    // this test only exercises RLS row visibility, not real encryption.
    await adminPool.query(
      `INSERT INTO agents (
         tenant_id, name, framework,
         connection_config_ciphertext, connection_config_iv, connection_config_auth_tag, connection_config_encrypted_dek, connection_config_key_version,
         hmac_secret_ciphertext, hmac_secret_iv, hmac_secret_auth_tag, hmac_secret_encrypted_dek, hmac_secret_key_version
       ) VALUES ($1, $2, $3, $4, $4, $4, $4, 1, $4, $4, $4, $4, 1)`,
      [tenantA.id, "rls-test-agent", "langchain", Buffer.from("placeholder")],
    );

    // This mirrors exactly what TenantContextMiddleware does per request:
    // check out a client, set_config('app.current_tenant', ..., true)
    // inside a transaction, query, then release.
    const clientA = await appPool.connect();
    let countAsA: number;
    try {
      await clientA.query("BEGIN");
      await clientA.query("SELECT set_config('app.current_tenant', $1, true)", [tenantA.id]);
      const result = await clientA.query("SELECT count(*)::int AS n FROM agents");
      countAsA = result.rows[0].n;
      await clientA.query("COMMIT");
    } finally {
      clientA.release();
    }
    assert.equal(countAsA, 1, "tenant A's own session should see its own agent");

    const clientB = await appPool.connect();
    let countAsB: number;
    try {
      await clientB.query("BEGIN");
      await clientB.query("SELECT set_config('app.current_tenant', $1, true)", [tenantB.id]);
      const result = await clientB.query("SELECT count(*)::int AS n FROM agents");
      countAsB = result.rows[0].n;
      await clientB.query("COMMIT");
    } finally {
      clientB.release();
    }
    assert.equal(countAsB, 0, "tenant B's session must NOT see tenant A's agent — this is the actual RLS enforcement point");
  } finally {
    for (const slug of [slugA, slugB]) {
      const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
      if (tenant.rows.length > 0) {
        const tenantId = tenant.rows[0].id;
        await adminPool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
        await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
        await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
        await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
      }
    }
    await adminPool.end();
    await appPool.end();
  }
});
