import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { DataClassificationTagger } from "../../src/classification/data-classification-tagger";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";

// System integration test (acceptance criteria: "the classification tag
// propagates to downstream consumers and audit_events"). Real PostgreSQL,
// same pattern as this repo's other integration tests.
const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-classification-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("a tagged event's classification is genuinely persisted on the audit_events row, not just the DEFAULT", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());

  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Classification Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const tagged = tagger.tag({ tenantId: tenant.id, resourceType: "health_record", fields: { note: "test" } });
    assert.equal(tagged.data_classification, "restricted");

    await audit.recordEvent({
      tenantId: tenant.id,
      actorId: null,
      action: "health_record.accessed",
      resourceType: tagged.resourceType,
      resourceId: tenant.id,
      details: { note: "integration test" },
      dataClassification: tagged.data_classification,
    });

    const rows = await pool.query(
      "SELECT data_classification FROM audit_events WHERE tenant_id = $1 AND action = 'health_record.accessed'",
      [tenant.id],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].data_classification, "restricted");

    // Sanity: the saga's own 'tenant.provisioned' event, which never
    // passes dataClassification, must still fall back to the column's
    // real DEFAULT rather than silently becoming NULL or erroring.
    const provisionedRow = await pool.query(
      "SELECT data_classification FROM audit_events WHERE tenant_id = $1 AND action = 'tenant.provisioned'",
      [tenant.id],
    );
    assert.equal(provisionedRow.rows[0].data_classification, "internal");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
