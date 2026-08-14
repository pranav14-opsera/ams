import { test } from "node:test";
import assert from "node:assert/strict";
import * as OTPAuth from "otpauth";
import { Pool } from "pg";
import { MfaService } from "../../../src/auth/mfa/mfa.service";
import { TotpProviderService } from "../../../src/auth/mfa/totp-provider.service";
import { UserMfaConfigRepository } from "../../../src/auth/mfa/user-mfa-config.repository";
import { InMemoryMfaRateLimiter } from "../../../src/auth/mfa/in-memory-mfa-rate-limiter.service";
import { InMemorySessionStore } from "../../../src/auth/session/in-memory-session-store.service";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-mfa-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM user_mfa_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

function generateCodeAt(base32Secret: string, timestamp: number): string {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(base32Secret), algorithm: "SHA1", digits: 6, period: 30 });
  return totp.generate({ timestamp });
}

function extractSecretFromUri(provisioningUri: string): string {
  const match = /secret=([A-Z2-7=]+)/.exec(provisioningUri);
  if (!match) throw new Error("no secret in provisioning URI");
  return match[1];
}

async function insertUser(pool: Pool, tenantId: string, userId: string, email: string): Promise<void> {
  await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)", [userId, tenantId, email, "Test User"]);
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const repo = new TenantRepository();
  const keyMetadataRepo = new TenantKeyMetadataRepository();
  const audit = new PostgresAuditService(pool);
  const rbac = new PostgresRbacService(pool);
  const saga = new TenantProvisioningSaga(pool, repo, keyMetadataRepo, kms, rbac, audit);
  const encryptionService = new EncryptionService(pool, kms, keyMetadataRepo, audit);
  const sessionStore = new InMemorySessionStore();
  const rateLimiter = new InMemoryMfaRateLimiter();
  const mfaService = new MfaService(pool, new TotpProviderService(), new UserMfaConfigRepository(), encryptionService, sessionStore, rateLimiter, audit);
  return { saga, mfaService, sessionStore, kms };
}

test("enroll returns a real provisioning URI and 10 unique backup codes, persisted encrypted", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, mfaService, kms } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "MFA Test Co", slug, dataResidencyRegion: "us", actorId: null });
    await kms.createTenantKey(tenant.id, "us"); // already created by saga, but harmless — asserts KMS is wired
    await insertUser(pool, tenant.id, "00000000-0000-0000-0000-000000000001", "user@example.com");
    const result = await mfaService.enroll("00000000-0000-0000-0000-000000000001", tenant.id, "user@example.com");

    assert.ok(result.provisioningUri.startsWith("otpauth://totp/"));
    assert.equal(result.backupCodes.length, 10);
    assert.equal(new Set(result.backupCodes).size, 10, "all 10 backup codes must be unique");

    const row = await pool.query("SELECT totp_secret_ciphertext, backup_codes FROM user_mfa_configs WHERE tenant_id = $1", [tenant.id]);
    assert.equal(row.rows.length, 1);
    assert.ok(row.rows[0].totp_secret_ciphertext, "the secret must be stored encrypted, not in plaintext anywhere queryable");
    assert.equal(row.rows[0].backup_codes.length, 10);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("verify with a real, correct TOTP code elevates the session and records an audit event", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, mfaService, sessionStore } = await buildRig(pool);
  const slug = randomSlug();
  const userId = "00000000-0000-0000-0000-000000000002";
  const sessionId = "session-1";

  try {
    const tenant = await saga.provision({ name: "MFA Verify Co", slug, dataResidencyRegion: "us", actorId: null });
    await insertUser(pool, tenant.id, userId, "clinician@example.com");
    await sessionStore.create({
      sessionId,
      userId,
      tenantId: tenant.id,
      deviceFingerprint: "fp",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      idleTimeoutSeconds: 1800,
      absoluteTimeoutSeconds: 28800,
      mfaElevated: false,
      mfaElevatedAt: null,
    });

    const enrollment = await mfaService.enroll(userId, tenant.id, "clinician@example.com");
    const secret = extractSecretFromUri(enrollment.provisioningUri);
    const code = generateCodeAt(secret, Date.now());

    await mfaService.verify(userId, tenant.id, sessionId, code);

    const session = await sessionStore.get(sessionId);
    assert.equal(session!.mfaElevated, true);
    assert.ok(session!.mfaElevatedAt);

    const auditRows = await pool.query("SELECT action, details FROM audit_events WHERE tenant_id = $1 AND action = 'auth.mfa.verified'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
    assert.equal(auditRows.rows[0].details.method, "totp");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("verify rejects the same valid code submitted twice (replay)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, mfaService, sessionStore } = await buildRig(pool);
  const slug = randomSlug();
  const userId = "00000000-0000-0000-0000-000000000003";
  const sessionId = "session-1";

  try {
    const tenant = await saga.provision({ name: "MFA Replay Co", slug, dataResidencyRegion: "us", actorId: null });
    await insertUser(pool, tenant.id, userId, "clinician@example.com");
    await sessionStore.create({
      sessionId, userId, tenantId: tenant.id, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
      idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: false, mfaElevatedAt: null,
    });
    const enrollment = await mfaService.enroll(userId, tenant.id, "clinician@example.com");
    const secret = extractSecretFromUri(enrollment.provisioningUri);
    const code = generateCodeAt(secret, Date.now());

    await mfaService.verify(userId, tenant.id, sessionId, code);
    await assert.rejects(() => mfaService.verify(userId, tenant.id, sessionId, code));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("verify rejects a wrong code and records a failure audit event", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, mfaService, sessionStore } = await buildRig(pool);
  const slug = randomSlug();
  const userId = "00000000-0000-0000-0000-000000000004";
  const sessionId = "session-1";

  try {
    const tenant = await saga.provision({ name: "MFA Wrong Code Co", slug, dataResidencyRegion: "us", actorId: null });
    await insertUser(pool, tenant.id, userId, "clinician@example.com");
    await sessionStore.create({
      sessionId, userId, tenantId: tenant.id, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
      idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: false, mfaElevatedAt: null,
    });
    await mfaService.enroll(userId, tenant.id, "clinician@example.com");

    await assert.rejects(() => mfaService.verify(userId, tenant.id, sessionId, "000000"));

    const session = await sessionStore.get(sessionId);
    assert.equal(session!.mfaElevated, false);
    const auditRows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'auth.mfa.verification_failed'", [tenant.id]);
    assert.equal(auditRows.rows.length, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a backup code verifies successfully exactly once, then is rejected on reuse", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, mfaService, sessionStore } = await buildRig(pool);
  const slug = randomSlug();
  const userId = "00000000-0000-0000-0000-000000000005";
  const sessionId = "session-1";

  try {
    const tenant = await saga.provision({ name: "MFA Backup Code Co", slug, dataResidencyRegion: "us", actorId: null });
    await insertUser(pool, tenant.id, userId, "clinician@example.com");
    await sessionStore.create({
      sessionId, userId, tenantId: tenant.id, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
      idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: false, mfaElevatedAt: null,
    });
    const enrollment = await mfaService.enroll(userId, tenant.id, "clinician@example.com");
    const backupCode = enrollment.backupCodes[0];

    await mfaService.verify(userId, tenant.id, sessionId, backupCode);
    const session = await sessionStore.get(sessionId);
    assert.equal(session!.mfaElevated, true);

    // Reset elevation to prove the SECOND attempt is rejected for being
    // a reused code, not just coincidentally already-elevated.
    await sessionStore.update(sessionId, { mfaElevated: false, mfaElevatedAt: null });
    await assert.rejects(() => mfaService.verify(userId, tenant.id, sessionId, backupCode));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("verify for a user who never enrolled is rejected", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, mfaService } = await buildRig(pool);
  const slug = randomSlug();

  try {
    const tenant = await saga.provision({ name: "MFA Not Enrolled Co", slug, dataResidencyRegion: "us", actorId: null });
    await insertUser(pool, tenant.id, "00000000-0000-0000-0000-000000000099", "nobody@example.com");
    await assert.rejects(() => mfaService.verify("00000000-0000-0000-0000-000000000099", tenant.id, "session-1", "123456"));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("rate limiting locks out after 5 failed attempts within the window", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, mfaService, sessionStore } = await buildRig(pool);
  const slug = randomSlug();
  const userId = "00000000-0000-0000-0000-000000000006";
  const sessionId = "session-1";

  try {
    const tenant = await saga.provision({ name: "MFA Rate Limit Co", slug, dataResidencyRegion: "us", actorId: null });
    await insertUser(pool, tenant.id, userId, "clinician@example.com");
    await sessionStore.create({
      sessionId, userId, tenantId: tenant.id, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
      idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: false, mfaElevatedAt: null,
    });
    await mfaService.enroll(userId, tenant.id, "clinician@example.com");

    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => mfaService.verify(userId, tenant.id, sessionId, "000000"));
    }
    // The 6th attempt must be rejected for rate-limiting BEFORE the code
    // is even checked — asserted via the HTTP status this WO's own
    // acceptance criteria specify (429), not just "rejects".
    await assert.rejects(
      () => mfaService.verify(userId, tenant.id, sessionId, "000000"),
      (err: any) => {
        assert.equal(err.getStatus(), 429);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
