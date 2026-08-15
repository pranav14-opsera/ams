import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { HealthGateway } from "../../src/websocket-gateway/gateways/health.gateway";
import { ConnectionRegistryService } from "../../src/websocket-gateway/connection-registry.service";
import { MessageBatcherService } from "../../src/websocket-gateway/message-batcher.service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { WsAuthService } from "../../src/websocket-gateway/ws-auth.service";
import { WsConnectionLimitConfigService } from "../../src/websocket-gateway/ws-connection-limit-config.service";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

/** Same fake as base-realtime.gateway.test.ts — HealthGateway is a thin channel="health" subclass, exercised through the identical shared lifecycle. */
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
  const gateway = new HealthGateway(authService, registry, pubsub, batcher, metrics, limitConfig);
  return { keyService, gateway, registry, pubsub };
}

async function cleanup(rig: ReturnType<typeof buildRig>) {
  await rig.registry.onModuleDestroy();
  await rig.pubsub.onModuleDestroy();
}

test("a fleet-health update published to the 'health' channel is delivered to a subscribed, same-tenant client", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/health?token=${token}` } as any);
    assert.equal(client.closed, undefined);

    await rig.pubsub.publish(tenantId, "health", { payload: { summary: { totalAgents: 3 } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 1);
    const frame = JSON.parse(client.sent[0]);
    assert.equal(frame.channel, "health");
    assert.deepEqual(frame.batch, [{ summary: { totalAgents: 3 } }]);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanup(rig);
  }
});

test("a health update for a DIFFERENT tenant is never delivered", { skip }, async () => {
  const rig = buildRig();
  const tenantA = `tenant-${randomUUID()}`;
  const tenantB = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantA, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/health?token=${token}` } as any);
    await rig.pubsub.publish(tenantB, "health", { payload: { summary: { totalAgents: 999 } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 0);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanup(rig);
  }
});
