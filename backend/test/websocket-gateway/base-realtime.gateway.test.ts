import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { BaseRealtimeGateway } from "../../src/websocket-gateway/gateways/base-realtime.gateway";
import { ConnectionRegistryService } from "../../src/websocket-gateway/connection-registry.service";
import { MessageBatcherService } from "../../src/websocket-gateway/message-batcher.service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { WsAuthService } from "../../src/websocket-gateway/ws-auth.service";
import { WsConnectionLimitConfigService } from "../../src/websocket-gateway/ws-connection-limit-config.service";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

class TestGateway extends BaseRealtimeGateway {
  protected readonly channel = "dashboard";
}

/** A minimal fake matching the `ws` WebSocket surface BaseRealtimeGateway actually uses. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  closed?: { code: number; reason: string };
  terminated = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  ping(): void {
    /* no-op — tests trigger 'pong' manually */
  }
}

function buildRig() {
  const keyService = new JwtKeyService();
  const verifier = new MultiKeyJwtVerifier(keyService);
  const authService = new WsAuthService(verifier);
  const registry = new ConnectionRegistryService();
  const pubsub = new RedisPubSubService();
  const batcher = new MessageBatcherService();
  const metrics = new WsMetricsService();
  const limitConfig = new WsConnectionLimitConfigService();
  const gateway = new TestGateway(authService, registry, pubsub, batcher, metrics, limitConfig);
  return { keyService, gateway, registry, pubsub, batcher, metrics };
}

async function cleanupRedisState(_tenantId: string, rig: ReturnType<typeof buildRig>) {
  await rig.registry.onModuleDestroy();
  await rig.pubsub.onModuleDestroy();
}

test("rejects the handshake with close code 4001 when no token is present", { skip }, async () => {
  const rig = buildRig();
  const client = new FakeSocket();

  await rig.gateway.handleConnection(client as any, { url: "/ws/dashboard" } as any);

  assert.equal(client.closed?.code, 4001);
  assert.equal(client.closed?.reason, "authentication_required");
  await cleanupRedisState("n/a", rig);
});

test("accepts a valid handshake, subscribes to the tenant's channel, and delivers a published message within the 100ms batch window", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard?token=${token}` } as any);
    assert.equal(client.closed, undefined, "a valid handshake must not be closed");

    await rig.pubsub.publish(tenantId, "dashboard", { payload: { metric: "cpu", value: 42 } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 1, "must arrive as exactly one batched frame");
    const frame = JSON.parse(client.sent[0]);
    assert.equal(frame.channel, "dashboard");
    assert.deepEqual(frame.batch, [{ metric: "cpu", value: 42 }]);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanupRedisState(tenantId, rig);
  }
});

test("a message with requiredRoles the connected user does NOT hold is never delivered (role-aware filtering)", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["finance_manager"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard?token=${token}` } as any);

    await rig.pubsub.publish(tenantId, "dashboard", { requiredRoles: ["agent_operator"], payload: { trace: "sensitive" } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 0, "finance_manager must never receive agent-operator-only trace data");
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanupRedisState(tenantId, rig);
  }
});

test("rejects the (N+1)th connection with close code 4029 once the tenant's connection limit is reached", { skip }, async () => {
  const tenantId = `tenant-${randomUUID()}`;
  process.env.TENANT_WS_CONNECTION_LIMIT_OVERRIDES = JSON.stringify({ [tenantId]: 1 });
  const rig = buildRig();

  try {
    const firstToken = rig.keyService.sign({ tid: tenantId, roles: [] }, "user-1", 900);
    const first = new FakeSocket();
    await rig.gateway.handleConnection(first as any, { url: `/ws/dashboard?token=${firstToken}` } as any);
    assert.equal(first.closed, undefined);

    const secondToken = rig.keyService.sign({ tid: tenantId, roles: [] }, "user-2", 900);
    const second = new FakeSocket();
    await rig.gateway.handleConnection(second as any, { url: `/ws/dashboard?token=${secondToken}` } as any);

    assert.equal(second.closed?.code, 4029);
    assert.ok(second.closed?.reason.startsWith("connection_limit_exceeded"));
    assert.ok(second.closed?.reason.includes("fallback=/api/v1/dashboard/poll"), "graceful degradation: the client must receive a fallback polling endpoint");

    await rig.gateway.handleDisconnect(first as any);
  } finally {
    delete process.env.TENANT_WS_CONNECTION_LIMIT_OVERRIDES;
    await cleanupRedisState(tenantId, rig);
  }
});

test("disconnect releases the tenant's connection slot, unsubscribes, and cancels any pending batch", { skip }, async () => {
  const tenantId = `tenant-${randomUUID()}`;
  process.env.TENANT_WS_CONNECTION_LIMIT_OVERRIDES = JSON.stringify({ [tenantId]: 1 });
  const rig = buildRig();

  try {
    const token = rig.keyService.sign({ tid: tenantId, roles: [] }, "user-1", 900);
    const client = new FakeSocket();
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard?token=${token}` } as any);
    assert.equal(rig.registry.getLocalConnectionCount(tenantId), 1);

    await rig.gateway.handleDisconnect(client as any);
    assert.equal(rig.registry.getLocalConnectionCount(tenantId), 0);

    // The freed slot must be immediately usable by a new connection.
    const secondToken = rig.keyService.sign({ tid: tenantId, roles: [] }, "user-2", 900);
    const second = new FakeSocket();
    await rig.gateway.handleConnection(second as any, { url: `/ws/dashboard?token=${secondToken}` } as any);
    assert.equal(second.closed, undefined);
    await rig.gateway.handleDisconnect(second as any);
  } finally {
    delete process.env.TENANT_WS_CONNECTION_LIMIT_OVERRIDES;
    await cleanupRedisState(tenantId, rig);
  }
});

test("onModuleDestroy (graceful shutdown) closes every locally-held connection with code 1001", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: [] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard?token=${token}` } as any);
    rig.gateway.onModuleDestroy();

    assert.equal(client.closed?.code, 1001);
  } finally {
    await cleanupRedisState(tenantId, rig);
  }
});
