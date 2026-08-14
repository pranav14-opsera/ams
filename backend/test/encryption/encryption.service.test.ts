import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";

// System integration test (acceptance criteria: "provision tenant with
// BYOK key, encrypt data, decrypt data, rotate key, verify old ciphertext
// still decryptable with new key version"). Real PostgreSQL, real
// end-to-end saga -> service wiring — no Docker/testcontainers available
// in this environment, same pattern as this repo's other integration
// tests.
const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-encryption-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("end-to-end: provision tenant, encrypt, decrypt, rotate, old ciphertext still decryptable", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const encryptionService = new EncryptionService(pool, kms, keyMetadataRepo, audit);

  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Encryption Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const metadataAfterProvision = await keyMetadataRepo.findByTenantId(pool, tenant.id);
    assert.ok(metadataAfterProvision, "tenant_key_metadata row must exist immediately after provisioning");
    assert.equal(metadataAfterProvision!.currentVersion, 1);
    assert.equal(metadataAfterProvision!.status, "active");

    const plaintext = Buffer.from("PHI payload for envelope encryption test");
    const encrypted = await encryptionService.encrypt(tenant.id, plaintext);
    const decrypted = await encryptionService.decrypt(tenant.id, encrypted);
    assert.deepEqual(decrypted, plaintext);

    const statusBeforeRotation = await encryptionService.getStatus(tenant.id);
    assert.equal(statusBeforeRotation.currentVersion, 1);

    await encryptionService.rotate(tenant.id, null);

    const metadataAfterRotation = await keyMetadataRepo.findByTenantId(pool, tenant.id);
    assert.equal(metadataAfterRotation!.currentVersion, 2, "tenant_key_metadata must reflect the new version");

    const rotationAuditRows = await pool.query(
      "SELECT details FROM audit_events WHERE tenant_id = $1 AND action = 'tenant.encryption_key.rotated'",
      [tenant.id],
    );
    assert.equal(rotationAuditRows.rows.length, 1);
    assert.equal(rotationAuditRows.rows[0].details.previousVersion, 1);
    assert.equal(rotationAuditRows.rows[0].details.newVersion, 2);

    // The acceptance criteria's explicit case: ciphertext encrypted
    // BEFORE rotation must still decrypt correctly after it.
    const decryptedAfterRotation = await encryptionService.decrypt(tenant.id, encrypted);
    assert.deepEqual(decryptedAfterRotation, plaintext);

    // New encryptions now use the new version.
    const newEncrypted = await encryptionService.encrypt(tenant.id, plaintext);
    assert.equal(newEncrypted.keyVersion, 2);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("schedule/cancel deletion round-trip updates both tenant_key_metadata and audit_events", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const encryptionService = new EncryptionService(pool, kms, keyMetadataRepo, audit);

  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Deletion Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const scheduled = await encryptionService.scheduleDeletion(tenant.id, null);
    assert.equal(scheduled.status, "pending_deletion");
    const metadataAfterSchedule = await keyMetadataRepo.findByTenantId(pool, tenant.id);
    assert.equal(metadataAfterSchedule!.status, "pending_deletion");
    assert.ok(metadataAfterSchedule!.pendingDeletionAt);

    const cancelled = await encryptionService.cancelDeletion(tenant.id, null);
    assert.equal(cancelled.status, "active");
    const metadataAfterCancel = await keyMetadataRepo.findByTenantId(pool, tenant.id);
    assert.equal(metadataAfterCancel!.status, "active");
    assert.equal(metadataAfterCancel!.pendingDeletionAt, null);

    const auditActions = await pool.query(
      "SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE 'tenant.encryption_key%' ORDER BY occurred_at",
      [tenant.id],
    );
    assert.deepEqual(
      auditActions.rows.map((r) => r.action),
      ["tenant.encryption_key.deletion_scheduled", "tenant.encryption_key.deletion_cancelled"],
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("getStatus 404s (via NotFoundException) for a tenant with no provisioned key", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new InMemoryKmsService();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, keyMetadataRepo, audit);

  await assert.rejects(() => encryptionService.getStatus("00000000-0000-0000-0000-000000000000"));
  await pool.end();
});
