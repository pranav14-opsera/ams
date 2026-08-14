export const REFRESH_TOKEN_STORE = "REFRESH_TOKEN_STORE";

export interface RefreshTokenRecord {
  userId: string;
  tenantId: string;
  deviceFingerprint: string;
  /** Role NAMES captured at original SSO login — sticky for this refresh token's lifetime. Permissions for those roles are still looked up fresh on every refresh, so a mid-session permission-grant change propagates without needing a brand-new login. */
  roles: string[];
  /** The session (WO-020) this refresh token belongs to — rotating the token keeps the SAME session alive rather than creating a new one each refresh. */
  sessionId: string;
}

// Production is intended to back this with Redis (this WO's own
// description: "stored server-side in Redis with device fingerprint
// binding"), same infrastructure (WO-004) and same connector-gap
// reasoning as WO-018's IdpMetadataCachePort — InMemoryRefreshTokenStore
// is a real, fully functional single-instance implementation, not a
// stub; multi-instance deployments sharing revocation state is the
// reason to swap in a real Redis-backed adapter later.
export interface RefreshTokenStorePort {
  store(tokenPlaintext: string, record: RefreshTokenRecord, ttlSeconds: number): Promise<void>;

  /** Atomically retrieves AND deletes the record in one step — a refresh token is single-use; even reading it twice concurrently must yield at most one valid consumption. Returns null if not found/expired. */
  consumeAndInvalidate(tokenPlaintext: string): Promise<RefreshTokenRecord | null>;

  /** Explicit invalidation without consuming a replacement — e.g. logout, or the device-fingerprint-mismatch case which must NOT re-issue a fresh token for the mismatched request. */
  invalidate(tokenPlaintext: string): Promise<void>;

  /** SCIM deprovisioning / admin force-logout (WO-020): every refresh token belonging to a user, revoked at once. */
  invalidateAllForUser(userId: string): Promise<void>;

  /** Admin force-logout of one specific session (WO-020): the refresh token(s) tied to that session, revoked. */
  invalidateForSession(sessionId: string): Promise<void>;
}
