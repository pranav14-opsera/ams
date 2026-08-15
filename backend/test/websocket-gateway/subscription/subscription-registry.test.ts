import { test } from "node:test";
import assert from "node:assert/strict";
import { SubscriptionRegistryService } from "../../../src/websocket-gateway/subscription/subscription-registry.service";
import type { UserSession } from "../../../src/websocket-gateway/subscription/subscription.types";

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    userId: "user-1",
    tenantId: "tenant-a",
    role: "agent_operator",
    permissions: [],
    subscribedChannels: new Set(),
    send: () => undefined,
    lastHeartbeat: Date.now(),
    connectedAt: Date.now(),
    ...overrides,
  };
}

test("addUser/getUser round-trip", () => {
  const registry = new SubscriptionRegistryService();
  const session = makeSession();
  registry.addUser(session);

  assert.equal(registry.getUser("tenant-a", "user-1"), session);
  assert.equal(registry.getUserCount("tenant-a"), 1);
  assert.equal(registry.getTenantCount(), 1);
});

test("removeUser cleans up all subscriptions and removes empty tenant buckets", () => {
  const registry = new SubscriptionRegistryService();
  registry.addUser(makeSession());
  registry.addSubscription("tenant-a", "user-1", "agent-health");

  registry.removeUser("tenant-a", "user-1");

  assert.equal(registry.getUser("tenant-a", "user-1"), undefined);
  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "agent-health").length, 0);
  assert.equal(registry.getTenantCount(), 0, "the tenant bucket itself must be removed once empty, not left as a dangling empty Map");
});

test("getUsersByTenantAndChannel returns only users subscribed to that exact channel within that tenant", () => {
  const registry = new SubscriptionRegistryService();
  registry.addUser(makeSession({ userId: "user-1", tenantId: "tenant-a" }));
  registry.addUser(makeSession({ userId: "user-2", tenantId: "tenant-a" }));
  registry.addUser(makeSession({ userId: "user-3", tenantId: "tenant-b" }));

  registry.addSubscription("tenant-a", "user-1", "agent-health");
  registry.addSubscription("tenant-a", "user-2", "credit-balance");
  registry.addSubscription("tenant-b", "user-3", "agent-health");

  const subscribers = registry.getUsersByTenantAndChannel("tenant-a", "agent-health");
  assert.deepEqual(
    subscribers.map((s) => s.userId),
    ["user-1"],
  );
});

test("removeSubscription only removes the named channel, leaving others intact", () => {
  const registry = new SubscriptionRegistryService();
  registry.addUser(makeSession());
  registry.addSubscription("tenant-a", "user-1", "agent-health");
  registry.addSubscription("tenant-a", "user-1", "alerts");

  registry.removeSubscription("tenant-a", "user-1", "agent-health");

  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "agent-health").length, 0);
  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "alerts").length, 1);
});

test("getAllStaleConnections returns only sessions whose lastHeartbeat exceeds the threshold", () => {
  const registry = new SubscriptionRegistryService();
  const now = 1_000_000;
  registry.addUser(makeSession({ userId: "fresh", lastHeartbeat: now - 1_000 }));
  registry.addUser(makeSession({ userId: "stale", lastHeartbeat: now - 40_000 }));

  const stale = registry.getAllStaleConnections(35_000, now);

  assert.deepEqual(
    stale.map((s) => s.userId),
    ["stale"],
  );
});

test("getAllSessions returns every registered session across every tenant", () => {
  const registry = new SubscriptionRegistryService();
  registry.addUser(makeSession({ userId: "user-1", tenantId: "tenant-a" }));
  registry.addUser(makeSession({ userId: "user-2", tenantId: "tenant-b" }));

  assert.equal(registry.getAllSessions().length, 2);
});
