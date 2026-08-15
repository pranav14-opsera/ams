import { test } from "node:test";
import assert from "node:assert/strict";
import { HeartbeatManagerService } from "../../../src/websocket-gateway/subscription/heartbeat-manager.service";
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

test("sweep pings every non-stale connection and leaves it registered", () => {
  const registry = new SubscriptionRegistryService();
  registry.addUser(makeSession({ lastHeartbeat: 1_000_000 }));
  const pinged: string[] = [];
  const terminated: string[] = [];
  const manager = new HeartbeatManagerService(registry, (userId) => pinged.push(userId), (userId) => terminated.push(userId));

  const result = manager.sweep(1_010_000); // 10s later, well under the 35s threshold

  assert.deepEqual(pinged, ["user-1"]);
  assert.deepEqual(terminated, []);
  assert.deepEqual(result, { pinged: 1, terminated: 0 });
});

test("sweep terminates a connection silent for longer than the stale threshold", () => {
  const registry = new SubscriptionRegistryService();
  registry.addUser(makeSession({ lastHeartbeat: 1_000_000 }));
  const terminated: string[] = [];
  const manager = new HeartbeatManagerService(registry, () => undefined, (userId) => terminated.push(userId), { staleThresholdMs: 35_000 });

  const result = manager.sweep(1_040_000); // 40s later, exceeds the 35s threshold

  assert.deepEqual(terminated, ["user-1"]);
  assert.equal(result.terminated, 1);
});

test("recordPong refreshes lastHeartbeat so a subsequent sweep no longer considers the session stale", () => {
  const registry = new SubscriptionRegistryService();
  const session = makeSession({ lastHeartbeat: 1_000_000 });
  registry.addUser(session);
  const terminated: string[] = [];
  const manager = new HeartbeatManagerService(registry, () => undefined, (userId) => terminated.push(userId), { staleThresholdMs: 35_000 });

  manager.recordPong(session, 1_039_000); // pong arrives just before the threshold would have tripped

  manager.sweep(1_070_000); // another 31s later — fresh relative to the pong, stale relative to the original heartbeat
  assert.deepEqual(terminated, [], "the refreshed heartbeat must be honored, not the original connect-time value");
});

test("start/stop schedule and cancel the sweep interval without throwing", () => {
  const registry = new SubscriptionRegistryService();
  const manager = new HeartbeatManagerService(registry, () => undefined, () => undefined, { sweepIntervalMs: 50 });

  manager.start();
  manager.start(); // idempotent — must not create a second interval
  manager.stop();
  manager.stop(); // idempotent — must not throw when already stopped
  manager.onModuleDestroy();
});
