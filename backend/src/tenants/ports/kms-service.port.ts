export const KMS_SERVICE = "KMS_SERVICE";

export type KeyStatus = "active" | "pending_deletion" | "disabled" | "rotation_due";

export interface KeyStatusInfo {
  status: KeyStatus;
  currentVersion: number;
  rotationDueAt: Date;
  pendingDeletionAt: Date | null;
}

export interface DataKey {
  /** Raw AES-256 key material. Callers must use it immediately and never persist it — only encryptedDataKey is durable. */
  plaintextKey: Buffer;
  encryptedDataKey: Buffer;
  keyVersion: number;
}

export interface EnvelopeCiphertext {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedDataKey: Buffer;
  keyVersion: number;
}

// Genuinely external (AWS KMS in production, infrastructure/terraform/modules/byok-grant)
// — the reason TenantProvisioningSaga (WO-013) needs a real compensating-
// rollback action rather than just relying on a DB transaction: if
// createTenantKey succeeds but a later saga step fails, the DB rolls back
// for free but the KMS grant does not.
//
// generateDataKey/encrypt/decrypt/rotateKey/scheduleKeyDeletion/
// cancelKeyDeletion/getKeyStatus are WO-015's envelope-encryption and key
// lifecycle surface. Only one concrete adapter (InMemoryKmsService) is
// implemented here — this WO's own acceptance criteria only require "at
// least one concrete adapter (e.g., AWS KMS OR a local/mock adapter)", and
// a real AWS KMS adapter needs the cloud provider decision (still pending
// per this WO's description) plus the @aws-sdk/client-kms dependency —
// tracked as follow-up work, not invented here. The port is shaped so
// that adapter is a drop-in later: every method maps directly onto a
// corresponding KMS API call (GenerateDataKey, Encrypt, Decrypt,
// ScheduleKeyDeletion, CancelKeyDeletion, DescribeKey) rather than
// anything mock-specific.
export interface KmsServicePort {
  /** Creates (or grants access to) a tenant-scoped encryption key. Returns its ARN. */
  createTenantKey(tenantId: string, dataResidencyRegion: "us" | "eu"): Promise<{ keyArn: string }>;

  /** Compensating action for createTenantKey — revokes/deletes the grant created above. Immediate, not the 7-day customer-facing deletion below. */
  deleteTenantKey(keyArn: string): Promise<void>;

  /** Generates a new AES-256 data encryption key (DEK), envelope-encrypted under the tenant's current key version. */
  generateDataKey(tenantId: string): Promise<DataKey>;

  /** Envelope-encrypts plaintext: generates a fresh DEK, AES-256-GCM encrypts with it, discards the plaintext DEK. */
  encrypt(tenantId: string, plaintext: Buffer): Promise<EnvelopeCiphertext>;

  /** Reverses encrypt(). Uses payload.keyVersion to unwrap encryptedDataKey even after the tenant's key has since been rotated. */
  decrypt(tenantId: string, payload: EnvelopeCiphertext): Promise<Buffer>;

  /** Bumps the tenant's current key version. Old versions are retained so previously-issued data keys stay decryptable. */
  rotateKey(tenantId: string): Promise<{ previousVersion: number; newVersion: number }>;

  /** Starts the mandatory 7-day deletion waiting period. */
  scheduleKeyDeletion(tenantId: string): Promise<{ pendingDeletionAt: Date }>;

  /** Cancels a pending deletion, returning the key to active. */
  cancelKeyDeletion(tenantId: string): Promise<void>;

  /** Live key status — analogous to KMS's DescribeKey, not a cached/DB value. */
  getKeyStatus(tenantId: string): Promise<KeyStatusInfo>;
}
