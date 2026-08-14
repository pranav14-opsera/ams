import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { REFRESH_TOKEN_STORE, type RefreshTokenStorePort } from "../token/refresh-token-store.port";
import { DEFAULT_SESSION_POLICY, TenantSessionPolicyRepository } from "./tenant-session-policy.repository";
import { SESSION_STORE, type SessionRecord, type SessionStorePort } from "./session-store.port";

const ACTIVITY_TOUCH_DEBOUNCE_SECONDS = 60;

@Injectable()
export class SessionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SESSION_STORE) private readonly sessionStore: SessionStorePort,
    @Inject(REFRESH_TOKEN_STORE) private readonly refreshTokenStore: RefreshTokenStorePort,
    private readonly policyRepository: TenantSessionPolicyRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async createSession(userId: string, tenantId: string, deviceFingerprint: string, now: Date = new Date()): Promise<SessionRecord> {
    const policy = (await this.policyRepository.findByTenantId(this.pool, tenantId)) ?? { tenantId, ...DEFAULT_SESSION_POLICY };

    const record: SessionRecord = {
      sessionId: randomUUID(),
      userId,
      tenantId,
      deviceFingerprint,
      createdAt: now,
      lastActivityAt: now,
      idleTimeoutSeconds: policy.idleTimeoutSeconds,
      absoluteTimeoutSeconds: policy.absoluteTimeoutSeconds,
      mfaElevated: false,
      mfaElevatedAt: null,
    };
    await this.sessionStore.create(record);

    await this.auditService.recordEvent({
      tenantId,
      actorId: userId,
      action: "auth.session.created",
      resourceType: "session",
      resourceId: record.sessionId,
      details: {},
    });

    return record;
  }

  /**
   * Throws UnauthorizedException (401, per this WO's acceptance
   * criteria) for a missing, idle-timed-out, or absolute-timed-out
   * session — invalidating it first in the timeout cases, so a stale
   * session can't be revived by a later request racing in just under
   * some other check.
   */
  async validateSession(sessionId: string, now: Date = new Date()): Promise<SessionRecord> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      throw new UnauthorizedException("Session is invalid or has expired.");
    }

    const idleElapsedSeconds = (now.getTime() - session.lastActivityAt.getTime()) / 1000;
    if (idleElapsedSeconds > session.idleTimeoutSeconds) {
      await this.invalidateSession(sessionId, "idle_timeout");
      throw new UnauthorizedException("Session is invalid or has expired.");
    }

    const absoluteElapsedSeconds = (now.getTime() - session.createdAt.getTime()) / 1000;
    if (absoluteElapsedSeconds > session.absoluteTimeoutSeconds) {
      await this.invalidateSession(sessionId, "absolute_timeout");
      throw new UnauthorizedException("Session is invalid or has expired.");
    }

    // Debounced touch: skip the write entirely if the last recorded
    // activity is recent enough — this WO's own acceptance criteria asks
    // for this specifically to reduce store write load on a
    // high-frequency path (every authenticated request).
    const secondsSinceLastTouch = (now.getTime() - session.lastActivityAt.getTime()) / 1000;
    if (secondsSinceLastTouch >= ACTIVITY_TOUCH_DEBOUNCE_SECONDS) {
      await this.sessionStore.touch(sessionId, now);
      session.lastActivityAt = now;
    }

    return session;
  }

  async invalidateSession(sessionId: string, reason: string): Promise<void> {
    const session = await this.sessionStore.get(sessionId);
    await this.sessionStore.delete(sessionId);
    await this.refreshTokenStore.invalidateForSession(sessionId);

    if (session) {
      await this.auditService.recordEvent({
        tenantId: session.tenantId,
        actorId: session.userId,
        action: "auth.session.invalidated",
        resourceType: "session",
        resourceId: sessionId,
        details: { reason },
      });
    }
  }

  /** SCIM deprovisioning (WO-025) or an admin disabling a user entirely — every session AND every refresh token for that user, gone at once. */
  async invalidateAllUserSessions(userId: string, tenantId: string, reason: string): Promise<void> {
    const sessionIds = await this.sessionStore.listSessionIdsForUser(userId);
    for (const sessionId of sessionIds) {
      await this.sessionStore.delete(sessionId);
    }
    await this.refreshTokenStore.invalidateAllForUser(userId);

    await this.auditService.recordEvent({
      tenantId,
      actorId: userId,
      action: "auth.session.all_invalidated",
      resourceType: "session",
      resourceId: userId,
      details: { reason, sessionCount: sessionIds.length },
    });
  }
}
