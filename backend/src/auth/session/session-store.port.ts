export const SESSION_STORE = "SESSION_STORE";

export interface SessionRecord {
  sessionId: string;
  userId: string;
  tenantId: string;
  deviceFingerprint: string;
  createdAt: Date;
  lastActivityAt: Date;
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
  mfaElevated: boolean;
  mfaElevatedAt: Date | null;
}

// Production is intended to back this with Redis (this WO's own
// description), same connector-gap reasoning as WO-018's
// IdpMetadataCachePort and WO-019's RefreshTokenStorePort —
// InMemorySessionStore is a real, functional single-instance
// implementation, not a stub; multi-instance deployments sharing session
// state (so a force-logout or SCIM deprovisioning on one API instance is
// honored by every other instance) is the reason to swap in a real
// Redis-backed adapter later.
export interface SessionStorePort {
  create(record: SessionRecord): Promise<void>;
  get(sessionId: string): Promise<SessionRecord | null>;
  /** Best-effort — callers debounce themselves (see SessionService) rather than relying on this to be a no-op for rapid repeated calls. */
  touch(sessionId: string, lastActivityAt: Date): Promise<void>;
  /** Partial update — e.g. MFA elevation (WO-021: mfaElevated/mfaElevatedAt) without re-specifying the whole record. No-ops if the session no longer exists. */
  update(sessionId: string, patch: Partial<Pick<SessionRecord, "mfaElevated" | "mfaElevatedAt">>): Promise<void>;
  delete(sessionId: string): Promise<void>;

  /** Every session currently open for a user — the SET this WO's implementation steps describe (user_sessions:{user_id}). */
  listSessionIdsForUser(userId: string): Promise<string[]>;
}
