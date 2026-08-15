import { test } from "node:test";
import assert from "node:assert/strict";
import { JwtKeyService } from "../../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../../src/auth/jwt/multi-key-jwt-verifier.service";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";
import { ChannelPermissionsService } from "../../../src/websocket-gateway/subscription/channel-permissions.service";
import { SubscriptionAuthenticationError, SubscriptionManagerService } from "../../../src/websocket-gateway/subscription/subscription-manager.service";
import { SubscriptionRegistryService } from "../../../src/websocket-gateway/subscription/subscription-registry.service";
import { CrossTenantSubscriptionError } from "../../../src/websocket-gateway/subscription/subscription.types";

function buildRig() {
  const keyService = new JwtKeyService();
  const verifier = new MultiKeyJwtVerifier(keyService);
  const registry = new SubscriptionRegistryService();
  const channelPermissions = new ChannelPermissionsService();
  const auditService = new InMemoryAuditService();
  const manager = new SubscriptionManagerService(verifier, registry, channelPermissions, auditService);
  return { keyService, registry, manager, auditService };
}

test("authenticateConnection accepts a valid token and registers the session", async () => {
  const { keyService, manager, registry } = buildRig();
  const token = keyService.sign({ tid: "tenant-a", roles: ["agent_operator"], permissions: ["agent_management:agent:trigger"] }, "user-1", 900);

  const session = await manager.authenticateConnection(token, () => undefined);

  assert.equal(session.userId, "user-1");
  assert.equal(session.tenantId, "tenant-a");
  assert.equal(registry.getUser("tenant-a", "user-1"), session);
});

test("authenticateConnection rejects an invalid token", async () => {
  const { manager } = buildRig();
  await assert.rejects(() => manager.authenticateConnection("not-a-real-token", () => undefined), SubscriptionAuthenticationError);
});

test("handleSubscribe rejects a cross-tenant subscription attempt, never registers it, and records a structured audit event", async () => {
  const { keyService, manager, registry, auditService } = buildRig();
  const token = keyService.sign({ tid: "tenant-a", roles: ["agent_operator"], permissions: [] }, "user-1", 900);
  const session = await manager.authenticateConnection(token, () => undefined);

  assert.throws(() => manager.handleSubscribe(session, "tenant-b", "agent-health"), CrossTenantSubscriptionError);
  assert.equal(registry.getUsersByTenantAndChannel("tenant-b", "agent-health").length, 0);
  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "agent-health").length, 0, "the rejected attempt must not silently subscribe under the session's own tenant either");

  assert.equal(auditService.events.length, 1);
  assert.equal(auditService.events[0].action, "websocket_subscription.cross_tenant_attempt_rejected");
  assert.equal(auditService.events[0].tenantId, "tenant-a", "recorded against the session's OWN verified tenant, never the attacker-supplied one");
  assert.equal(auditService.events[0].actorId, "user-1");
});

test("handleSubscribe rejects a channel the user's permissions do not allow and records a structured audit event", async () => {
  const { keyService, manager, registry, auditService } = buildRig();
  const token = keyService.sign({ tid: "tenant-a", roles: ["agent_operator"], permissions: ["agent_management:agent:trigger"] }, "user-1", 900);
  const session = await manager.authenticateConnection(token, () => undefined);

  assert.throws(() => manager.handleSubscribe(session, "tenant-a", "phi-access"), CrossTenantSubscriptionError);
  assert.equal(auditService.events.length, 1);
  assert.equal(auditService.events[0].action, "websocket_subscription.permission_denied");
  assert.equal(auditService.events[0].dataClassification, "restricted", "a PHI-gated channel's denial must be tagged at least as sensitive as the data it protects");
  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "phi-access").length, 0);
});

test("handleSubscribe succeeds for a same-tenant, permitted channel", async () => {
  const { keyService, manager, registry } = buildRig();
  const token = keyService.sign({ tid: "tenant-a", roles: ["compliance_officer"], permissions: ["audit_access:phi_monitoring:view"] }, "user-1", 900);
  const session = await manager.authenticateConnection(token, () => undefined);

  manager.handleSubscribe(session, "tenant-a", "phi-access");

  assert.deepEqual(
    registry.getUsersByTenantAndChannel("tenant-a", "phi-access").map((s) => s.userId),
    ["user-1"],
  );
});

test("handleUnsubscribe removes only the named channel", async () => {
  const { keyService, manager, registry } = buildRig();
  const token = keyService.sign({ tid: "tenant-a", roles: [], permissions: [] }, "user-1", 900);
  const session = await manager.authenticateConnection(token, () => undefined);
  manager.handleSubscribe(session, "tenant-a", "agent-health");
  manager.handleSubscribe(session, "tenant-a", "alerts");

  manager.handleUnsubscribe(session, "agent-health");

  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "agent-health").length, 0);
  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "alerts").length, 1);
});

test("handleDisconnect removes the user entirely from the registry", async () => {
  const { keyService, manager, registry } = buildRig();
  const token = keyService.sign({ tid: "tenant-a", roles: [], permissions: [] }, "user-1", 900);
  const session = await manager.authenticateConnection(token, () => undefined);
  manager.handleSubscribe(session, "tenant-a", "agent-health");

  manager.handleDisconnect(session);

  assert.equal(registry.getUser("tenant-a", "user-1"), undefined);
  assert.equal(registry.getUsersByTenantAndChannel("tenant-a", "agent-health").length, 0);
});

test("fanOutMessage delivers only to same-tenant, subscribed, permitted users", async () => {
  const { keyService, manager } = buildRig();
  const receivedByUser = new Map<string, unknown[]>();
  const track = (userId: string) => (payload: unknown) => {
    receivedByUser.set(userId, [...(receivedByUser.get(userId) ?? []), payload]);
  };

  const tokenA1 = keyService.sign({ tid: "tenant-a", roles: ["agent_operator"], permissions: [] }, "user-a1", 900);
  const sessionA1 = await manager.authenticateConnection(tokenA1, track("user-a1"));
  manager.handleSubscribe(sessionA1, "tenant-a", "agent-health");

  const tokenA2 = keyService.sign({ tid: "tenant-a", roles: ["finance_manager"], permissions: [] }, "user-a2", 900);
  await manager.authenticateConnection(tokenA2, track("user-a2"));
  // user-a2 never subscribes to agent-health

  const tokenB1 = keyService.sign({ tid: "tenant-b", roles: ["agent_operator"], permissions: [] }, "user-b1", 900);
  const sessionB1 = await manager.authenticateConnection(tokenB1, track("user-b1"));
  manager.handleSubscribe(sessionB1, "tenant-b", "agent-health");

  const result = manager.fanOutMessage("tenant-a", "agent-health", { agentId: "agent-1", status: "healthy" });

  assert.deepEqual(result.delivered, ["user-a1"]);
  assert.deepEqual(receivedByUser.get("user-a1"), [{ agentId: "agent-1", status: "healthy" }]);
  assert.equal(receivedByUser.has("user-a2"), false, "unsubscribed same-tenant user must not receive the event");
  assert.equal(receivedByUser.has("user-b1"), false, "cross-tenant user must never receive tenant-a's event, even though it subscribed to the same channel name");
});

test("fanOutMessage filters out subscribers who lack the channel's required permission", async () => {
  const { keyService, manager } = buildRig();
  const received: unknown[] = [];

  const token = keyService.sign({ tid: "tenant-a", roles: ["agent_operator"], permissions: [] }, "user-a1", 900);
  const session = await manager.authenticateConnection(token, (payload) => received.push(payload));
  // Force a subscription past the normal handleSubscribe gate to exercise fan-out-time filtering directly
  // (simulates a permission downgrade after a valid subscription was already established).
  session.subscribedChannels.add("phi-access");

  const result = manager.fanOutMessage("tenant-a", "phi-access", { recordType: "patient_note" });

  assert.deepEqual(result.filtered, ["user-a1"]);
  assert.deepEqual(received, []);
});
