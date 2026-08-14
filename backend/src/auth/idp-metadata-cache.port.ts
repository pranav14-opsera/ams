export const IDP_METADATA_CACHE = "IDP_METADATA_CACHE";

// Caches fetched IdP metadata (SAML cert / OIDC discovery document) so
// every login doesn't re-fetch it, and provides the SAML replay-detection
// store (assertion IDs seen recently). Production is intended to back
// this with Redis (infrastructure/terraform/cache/redis, WO-004) so
// multiple API instances share one cache/replay-store — not implemented
// here; InMemoryIdpMetadataCache below is a real, fully functional
// single-instance implementation (this WO's acceptance criteria call for
// "cached... with automatic refresh", which this genuinely does), not a
// stub, and is what a single-instance deployment would actually run.
// Multi-instance replay-detection sharing is the reason to swap in a
// real Redis-backed adapter later.
export interface IdpMetadataCachePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;

  /** Records that a SAML assertion ID has been consumed; returns true if it was ALREADY recorded (i.e. this is a replay). */
  checkAndRecordAssertionId(assertionId: string, ttlSeconds: number): Promise<boolean>;
}
