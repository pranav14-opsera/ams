import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { OrgUsageGateway } from "../../src/websocket-gateway/gateways/org-usage.gateway";
import { ConnectionRegistryService } from "../../src/websocket-gateway/connection-registry.service";
import { MessageBatcherService } from "../../src/websocket-gateway/message-batcher.service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { WsAuthService } from "../../src/websocket-gateway/ws-auth.service";
import { WsConnectionLimitConfigService } from "../../src/websocket-gateway/ws-connection-limit-config.service";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

/** Same fake as health.gateway.test.ts — OrgUsageGateway is a thin channel="org_usage" subclass, exercised through the identical shared BaseRealtimeGateway lifecycle. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  closed?: { code: number; reason: string };

  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
  ping(): void {
    /* no-op */
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
  const gateway = new OrgUsageGateway(authService, registry, pubsub, batcher, metrics, limitConfig);
  return { keyService, gateway, registry, pubsub };
}

async function cleanup(rig: ReturnType<typeof buildRig>) {
  await rig.registry.onModuleDestroy();
  await rig.pubsub.onModuleDestroy();
}

test("an org_usage update published for the caller's tenant is delivered within the 100ms batch window", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard/usage/org?token=${token}` } as any);
    assert.equal(client.closed, undefined);

    await rig.pubsub.publish(tenantId, "org_usage", { payload: { type: "usage_update", data: { balance: { total: 100, consumed: 10, remaining: 90 } } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 1);
    const frame = JSON.parse(client.sent[0]);
    assert.equal(frame.channel, "org_usage");
    assert.deepEqual(frame.batch, [{ type: "usage_update", data: { balance: { total: 100, consumed: 10, remaining: 90 } } }]);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanup(rig);
  }
});

test("an org_usage update for a DIFFERENT tenant is never delivered — tenant isolation on the WebSocket push path", { skip }, async () => {
  const rig = buildRig();
  const tenantA = `tenant-${randomUUID()}`;
  const tenantB = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantA, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard/usage/org?token=${token}` } as any);
    await rig.pubsub.publish(tenantB, "org_usage", { payload: { type: "usage_update", data: { balance: { total: 999, consumed: 0, remaining: 999 } } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 0);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanup(rig);
  }
});

test("two concurrent connections from the same tenant each receive the update independently (no duplication, no cross-talk)", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["platform_admin"] }, "user-1", 900);
  const clientA = new FakeSocket();
  const clientB = new FakeSocket();

  try {
    await rig.gateway.handleConnection(clientA as any, { url: `/ws/dashboard/usage/org?token=${token}` } as any);
    await rig.gateway.handleConnection(clientB as any, { url: `/ws/dashboard/usage/org?token=${token}` } as any);

    await rig.pubsub.publish(tenantId, "org_usage", { payload: { type: "usage_update", data: { balance: { total: 1, consumed: 0, remaining: 1 } } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(clientA.sent.length, 1);
    assert.equal(clientB.sent.length, 1);
  } finally {
    await rig.gateway.handleDisconnect(clientA as any);
    await rig.gateway.handleDisconnect(clientB as any);
    await cleanup(rig);
  }
});
