import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DataKey, EnvelopeCiphertext, KeyStatus, KeyStatusInfo, KmsServicePort } from "../kms-service.port";

const AES_KEY_LENGTH = 32; // AES-256
const GCM_IV_LENGTH = 12; // NIST SP 800-38D recommended IV length for GCM
const GCM_AUTH_TAG_LENGTH = 16;
const ROTATION_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000; // 90-day rotation policy, matching infrastructure/terraform/kms rotation docs
const DELETION_WAITING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // mandatory per this WO's acceptance criteria

interface TenantKeyState {
  keyArn: string;
  /** Every version's master key is retained, never discarded — real AWS KMS does the same, so a DEK wrapped under an old version stays decryptable after rotation. */
  versions: Map<number, Buffer>;
  currentVersion: number;
  status: Exclude<KeyStatus, "rotation_due">; // "rotation_due" is computed from rotationDueAt, never stored
  rotationDueAt: Date;
  pendingDeletionAt: Date | null;
}

// Test/local-dev stand-in — the real AWS KMS-backed adapter is tracked as
// follow-up work (see kms-service.port.ts's header comment). Implements
// real AES-256-GCM envelope encryption with node:crypto, not a fake no-op,
// so tests against this adapter exercise the actual cryptographic
// round-trip WO-015's acceptance criteria require.
//
// Deliberately issues a fresh DEK per encrypt() call rather than caching
// "active data keys" server-side — there is no DEK cache to invalidate on
// rotation. What must (and does) survive rotation is the ability to
// decrypt a DEK that was wrapped under an older key version, which is
// exactly what retaining `versions` (never pruning old entries) gives you.
@Injectable()
export class InMemoryKmsService implements KmsServicePort {
  private readonly tenantKeys = new Map<string, TenantKeyState>();
  private readonly arnToTenant = new Map<string, string>();
  private keyCounter = 0;

  /** Kept for WO-013's saga tests, which assert on which ARNs exist/were rolled back. Derived, not separately maintained state. */
  get createdKeys(): ReadonlySet<string> {
    return new Set(this.arnToTenant.keys());
  }

  async createTenantKey(tenantId: string, dataResidencyRegion: "us" | "eu"): Promise<{ keyArn: string }> {
    this.keyCounter += 1;
    const keyArn = `arn:aws:kms:${dataResidencyRegion === "eu" ? "eu-west-1" : "us-east-1"}:000000000000:key/in-memory-${tenantId}-${this.keyCounter}`;

    const versions = new Map<number, Buffer>();
    versions.set(1, randomBytes(AES_KEY_LENGTH));

    this.tenantKeys.set(tenantId, {
      keyArn,
      versions,
      currentVersion: 1,
      status: "active",
      rotationDueAt: new Date(Date.now() + ROTATION_INTERVAL_MS),
      pendingDeletionAt: null,
    });
    this.arnToTenant.set(keyArn, tenantId);

    return { keyArn };
  }

  async deleteTenantKey(keyArn: string): Promise<void> {
    const tenantId = this.arnToTenant.get(keyArn);
    if (!tenantId) return;
    this.tenantKeys.delete(tenantId);
    this.arnToTenant.delete(keyArn);
  }

  async generateDataKey(tenantId: string): Promise<DataKey> {
    const state = this.requireActiveKey(tenantId);
    const plaintextKey = randomBytes(AES_KEY_LENGTH);
    const encryptedDataKey = this.wrapKey(state.versions.get(state.currentVersion)!, plaintextKey);
    return { plaintextKey, encryptedDataKey, keyVersion: state.currentVersion };
  }

  async encrypt(tenantId: string, plaintext: Buffer): Promise<EnvelopeCiphertext> {
    const { plaintextKey, encryptedDataKey, keyVersion } = await this.generateDataKey(tenantId);
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", plaintextKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    plaintextKey.fill(0); // never persisted, never returned — scrub it as soon as it's used
    return { ciphertext, iv, authTag, encryptedDataKey, keyVersion };
  }

  async decrypt(tenantId: string, payload: EnvelopeCiphertext): Promise<Buffer> {
    const state = this.tenantKeys.get(tenantId);
    if (!state) {
      throw new Error(`No KMS key found for tenant ${tenantId}.`);
    }
    const masterKey = state.versions.get(payload.keyVersion);
    if (!masterKey) {
      throw new Error(`Tenant ${tenantId} has no retained key material for version ${payload.keyVersion}.`);
    }
    const dataKey = this.unwrapKey(masterKey, payload.encryptedDataKey);
    const decipher = createDecipheriv("aes-256-gcm", dataKey, payload.iv);
    decipher.setAuthTag(payload.authTag);
    const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
    dataKey.fill(0);
    return plaintext;
  }

  async rotateKey(tenantId: string): Promise<{ previousVersion: number; newVersion: number }> {
    const state = this.requireActiveKey(tenantId);
    const previousVersion = state.currentVersion;
    const newVersion = previousVersion + 1;
    state.versions.set(newVersion, randomBytes(AES_KEY_LENGTH)); // old versions stay in the map — see class-level comment
    state.currentVersion = newVersion;
    state.rotationDueAt = new Date(Date.now() + ROTATION_INTERVAL_MS);
    return { previousVersion, newVersion };
  }

  async scheduleKeyDeletion(tenantId: string): Promise<{ pendingDeletionAt: Date }> {
    const state = this.getState(tenantId);
    const pendingDeletionAt = new Date(Date.now() + DELETION_WAITING_PERIOD_MS);
    state.status = "pending_deletion";
    state.pendingDeletionAt = pendingDeletionAt;
    return { pendingDeletionAt };
  }

  async cancelKeyDeletion(tenantId: string): Promise<void> {
    const state = this.getState(tenantId);
    if (state.status !== "pending_deletion") {
      throw new Error(`Tenant ${tenantId}'s key is not pending deletion.`);
    }
    state.status = "active";
    state.pendingDeletionAt = null;
  }

  async getKeyStatus(tenantId: string): Promise<KeyStatusInfo> {
    const state = this.getState(tenantId);
    const status: KeyStatus = state.status === "active" && Date.now() >= state.rotationDueAt.getTime() ? "rotation_due" : state.status;
    return {
      status,
      currentVersion: state.currentVersion,
      rotationDueAt: state.rotationDueAt,
      pendingDeletionAt: state.pendingDeletionAt,
    };
  }

  /** Executes deletions whose 7-day wait has elapsed. Mirrors a scheduled job's entry point — see scripts/process-key-deletions.ts. */
  async processExpiredDeletions(now: Date = new Date()): Promise<string[]> {
    const deletedTenantIds: string[] = [];
    for (const [tenantId, state] of this.tenantKeys.entries()) {
      if (state.status === "pending_deletion" && state.pendingDeletionAt && now >= state.pendingDeletionAt) {
        await this.deleteTenantKey(state.keyArn);
        deletedTenantIds.push(tenantId);
      }
    }
    return deletedTenantIds;
  }

  private getState(tenantId: string): TenantKeyState {
    const state = this.tenantKeys.get(tenantId);
    if (!state) {
      throw new Error(`No KMS key found for tenant ${tenantId}.`);
    }
    return state;
  }

  private requireActiveKey(tenantId: string): TenantKeyState {
    const state = this.getState(tenantId);
    if (state.status === "pending_deletion" || state.status === "disabled") {
      throw new Error(`Tenant ${tenantId}'s key is ${state.status} and cannot be used for new cryptographic operations.`);
    }
    return state;
  }

  /** Wraps a DEK under a master key version — AES-256-GCM, IV+authTag prefixed onto the ciphertext for a single self-contained blob. */
  private wrapKey(masterKey: Buffer, dataKey: Buffer): Buffer {
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
  }

  private unwrapKey(masterKey: Buffer, encryptedDataKey: Buffer): Buffer {
    const iv = encryptedDataKey.subarray(0, GCM_IV_LENGTH);
    const authTag = encryptedDataKey.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
    const wrapped = encryptedDataKey.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  }
}
