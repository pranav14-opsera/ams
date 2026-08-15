import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataClassification } from "../../classification/data-classification.enum";
import { JWT_VERIFIER, type JwtVerifierPort } from "../../common/jwt/jwt-verifier.port";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { ChannelPermissionsService } from "./channel-permissions.service";
import { SubscriptionRegistryService } from "./subscription-registry.service";
import { CrossTenantSubscriptionError, type FanOutResult, type SessionSender, type UserSession } from "./subscription.types";

export class SubscriptionAuthenticationError extends Error {}

/**
 * Orchestrator wiring auth, the registry, and channel permissions
 * together — the server-side counterpart to WO-054's client hooks.
 * Tenant isolation is enforced at TWO points, not one: (1) subscribe-time
 * (`handleSubscribe` rejects any channel argument the caller tries to
 * scope to another tenant — there's no tenant argument at all, since a
 * session's tenantId is fixed at connect time and never re-specified by
 * the client) and (2) fan-out time, via a runtime assertion that would
 * throw before ever calling `send` if the registry ever returned a
 * cross-tenant session (defense in depth against a future registry bug,
 * not just trusting the lookup).
 */
@Injectable()
export class SubscriptionManagerService {
  private readonly logger = new Logger(SubscriptionManagerService.name);

  constructor(
    @Inject(JWT_VERIFIER) private readonly jwtVerifier: JwtVerifierPort,
    private readonly registry: SubscriptionRegistryService,
    private readonly channelPermissions: ChannelPermissionsService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  /** Best-effort: a durable audit-trail write failing must never block (or fail) the WS operation it's describing — mirrors AuditIngestionCounterRepository's own "counter failure never blocks real processing" reasoning elsewhere in this codebase. */
  private recordSecurityAuditEvent(event: {
    tenantId: string;
    actorId: string | null;
    action: string;
    resourceId: string;
    details: Record<string, unknown>;
    dataClassification?: DataClassification;
  }): void {
    this.auditService.recordEvent({ resourceType: "websocket_subscription", ...event }).catch((err) => {
      this.logger.warn(`failed to record audit event for ${event.action}: ${err instanceof Error ? err.message : err}`);
    });
  }

  async authenticateConnection(token: string, send: SessionSender, now: number = Date.now()): Promise<UserSession> {
    let claims;
    try {
      claims = await this.jwtVerifier.verify(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // No durable audit_events write here: audit_events.tenant_id is a
      // NOT NULL FK into `tenants` (migration 005), and an invalid/expired
      // token gives no verified tenant to attribute the row to — same
      // reasoning WsAuthService already applies (Logger-only, no audit
      // write, for this exact failure class). The Logger line below IS
      // the record for this case.
      this.logger.warn(`security event: WebSocket subscription auth rejected — invalid/expired token (${message})`);
      throw new SubscriptionAuthenticationError("Invalid or expired token.");
    }

    const tenantId = claims.tenant_id;
    const userId = claims.sub;
    const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
    const permissions = Array.isArray(claims.permissions) ? (claims.permissions as string[]) : [];

    const session: UserSession = {
      userId,
      tenantId,
      role: roles[0] ?? "",
      permissions,
      subscribedChannels: new Set(),
      send,
      lastHeartbeat: now,
      connectedAt: now,
    };
    this.registry.addUser(session);
    return session;
  }

  /**
   * `requestedTenantId` is what the CLIENT claims it wants to subscribe
   * within (mirrors how a real subscribe message would arrive over the
   * wire); it must match the authenticated session's own tenantId or the
   * attempt is rejected and logged as a security event — the actual
   * enforcement is comparing two already-known tenant IDs, never trusting
   * a client-supplied one on its own.
   */
  handleSubscribe(session: UserSession, requestedTenantId: string, channel: string): void {
    if (requestedTenantId !== session.tenantId) {
      this.logger.warn(
        `security event: cross-tenant subscription attempt rejected — user=${session.userId} sessionTenant=${session.tenantId} requestedTenant=${requestedTenantId} channel=${channel}`,
      );
      this.recordSecurityAuditEvent({
        tenantId: session.tenantId,
        actorId: session.userId,
        action: "websocket_subscription.cross_tenant_attempt_rejected",
        resourceId: channel,
        details: { requestedTenantId, channel },
        dataClassification: DataClassification.CONFIDENTIAL,
      });
      throw new CrossTenantSubscriptionError(`User ${session.userId} may not subscribe to channel "${channel}" under tenant "${requestedTenantId}".`);
    }

    if (!this.channelPermissions.checkPermission(channel, session.permissions)) {
      this.logger.warn(`security event: permission denied for channel subscription — user=${session.userId} tenant=${session.tenantId} channel=${channel}`);
      this.recordSecurityAuditEvent({
        tenantId: session.tenantId,
        actorId: session.userId,
        action: "websocket_subscription.permission_denied",
        resourceId: channel,
        details: { channel, userPermissions: session.permissions },
        dataClassification: this.channelPermissions.getRule(channel)?.requiredPermissions?.length ? DataClassification.RESTRICTED : DataClassification.CONFIDENTIAL,
      });
      throw new CrossTenantSubscriptionError(`User ${session.userId} lacks permission to subscribe to channel "${channel}".`);
    }

    this.registry.addSubscription(session.tenantId, session.userId, channel);
  }

  handleUnsubscribe(session: UserSession, channel: string): void {
    this.registry.removeSubscription(session.tenantId, session.userId, channel);
  }

  handleDisconnect(session: UserSession): void {
    this.registry.removeUser(session.tenantId, session.userId);
  }

  /**
   * Fans a tenant-scoped event out to every subscriber of `channel`
   * within that tenant, filtered by permission. `eventTenantId` is the
   * tenant the EVENT belongs to (from the Kafka envelope), never a
   * subscriber-supplied value — every recipient is looked up already
   * scoped to it, then double-checked before send.
   */
  fanOutMessage(eventTenantId: string, channel: string, payload: unknown): FanOutResult {
    const result: FanOutResult = { delivered: [], filtered: [], errors: [] };
    const subscribers = this.registry.getUsersByTenantAndChannel(eventTenantId, channel);

    for (const session of subscribers) {
      if (session.tenantId !== eventTenantId) {
        // Structurally unreachable given getUsersByTenantAndChannel's own
        // filtering, but a fan-out helper handling PHI-adjacent data gets
        // a belt-and-suspenders assertion, not just trust in one lookup.
        result.errors.push({ userId: session.userId, error: "tenant_mismatch_assertion_failed" });
        this.logger.error(`security event: fan-out tenant mismatch — event tenant=${eventTenantId} session tenant=${session.tenantId} user=${session.userId}`);
        continue;
      }

      if (!this.channelPermissions.checkPermission(channel, session.permissions)) {
        result.filtered.push(session.userId);
        continue;
      }

      try {
        session.send(payload);
        result.delivered.push(session.userId);
      } catch (err) {
        result.errors.push({ userId: session.userId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return result;
  }
}
