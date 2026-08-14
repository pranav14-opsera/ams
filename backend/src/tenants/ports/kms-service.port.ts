export const KMS_SERVICE = "KMS_SERVICE";

// Genuinely external (AWS KMS in production, infrastructure/terraform/modules/byok-grant)
// — the one saga step that isn't a plain Postgres statement, and the
// reason the saga needs a real compensating-rollback action rather than
// just relying on a DB transaction: if this succeeds but a later step
// fails, the DB rolls back for free but this KMS grant does not.
export interface KmsServicePort {
  /** Creates (or grants access to) a tenant-scoped encryption key. Returns its ARN. */
  createTenantKey(tenantId: string, dataResidencyRegion: "us" | "eu"): Promise<{ keyArn: string }>;

  /** Compensating action for createTenantKey — revokes/deletes the grant created above. */
  deleteTenantKey(keyArn: string): Promise<void>;
}
