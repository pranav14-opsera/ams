import { Injectable } from "@nestjs/common";
import type { UserSession } from "./subscription.types";

/**
 * Nested-Map registry: tenantId -> Map<userId, UserSession>. Both the
 * per-tenant lookup (`getUsersByTenantAndChannel`) and the per-user
 * lookup (`removeUser`) are O(1) — no scanning across tenants for either
 * operation, which matters at the 50-connections-per-tenant scale this
 * WO targets.
 */
@Injectable()
export class SubscriptionRegistryService {
  private readonly byTenant = new Map<string, Map<string, UserSession>>();

  addUser(session: UserSession): void {
    let tenantUsers = this.byTenant.get(session.tenantId);
    if (!tenantUsers) {
      tenantUsers = new Map();
      this.byTenant.set(session.tenantId, tenantUsers);
    }
    tenantUsers.set(session.userId, session);
  }

  removeUser(tenantId: string, userId: string): void {
    const tenantUsers = this.byTenant.get(tenantId);
    if (!tenantUsers) return;

    tenantUsers.delete(userId);
    if (tenantUsers.size === 0) this.byTenant.delete(tenantId);
  }

  getUser(tenantId: string, userId: string): UserSession | undefined {
    return this.byTenant.get(tenantId)?.get(userId);
  }

  addSubscription(tenantId: string, userId: string, channel: string): void {
    this.getUser(tenantId, userId)?.subscribedChannels.add(channel);
  }

  removeSubscription(tenantId: string, userId: string, channel: string): void {
    this.getUser(tenantId, userId)?.subscribedChannels.delete(channel);
  }

  /** The single fan-out lookup path — every recipient returned here is, by construction, in `tenantId` and subscribed to `channel`. */
  getUsersByTenantAndChannel(tenantId: string, channel: string): UserSession[] {
    const tenantUsers = this.byTenant.get(tenantId);
    if (!tenantUsers) return [];

    return [...tenantUsers.values()].filter((session) => session.subscribedChannels.has(channel));
  }

  getUserCount(tenantId: string): number {
    return this.byTenant.get(tenantId)?.size ?? 0;
  }

  getTenantCount(): number {
    return this.byTenant.size;
  }

  getAllStaleConnections(thresholdMs: number, now: number = Date.now()): UserSession[] {
    return this.getAllSessions().filter((session) => now - session.lastHeartbeat > thresholdMs);
  }

  getAllSessions(): UserSession[] {
    const sessions: UserSession[] = [];
    for (const tenantUsers of this.byTenant.values()) sessions.push(...tenantUsers.values());
    return sessions;
  }
}
