import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { TeamUsageGateway } from "../../src/websocket-gateway/gateways/team-usage.gateway";
import { ConnectionRegistryService } from "../../src/websocket-gateway/connection-registry.service";
import { MessageBatcherService } from "../../src/websocket-gateway/message-batcher.service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { WsAuthService } from "../../src/websocket-gateway/ws-auth.service";
import { WsConnectionLimitConfigService } from "../../src/websocket-gateway/ws-connection-limit-config.service";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

/** Same fake as org-usage.gateway.test.ts — TeamUsageGateway is a thin channel="team_usage" subclass, exercised through the identical shared BaseRealtimeGateway lifecycle. */
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
  const gateway = new TeamUsageGateway(authService, registry, pubsub, batcher, metrics, limitConfig);
  return { keyService, gateway, registry, pubsub };
}

async function cleanup(rig: ReturnType<typeof buildRig>) {
  await rig.registry.onModuleDestroy();
  await rig.pubsub.onModuleDestroy();
}

test("a team_usage update published for the caller's tenant is delivered within the 100ms batch window", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const teamId = `team-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard/usage/team?token=${token}` } as any);
    assert.equal(client.closed, undefined);

    await rig.pubsub.publish(tenantId, "team_usage", { payload: { type: "team_usage_update", data: { teamId, balance: { allocated: 100, consumed: 10, remaining: 90, utilizationPct: 10 } } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 1);
    const frame = JSON.parse(client.sent[0]);
    assert.equal(frame.channel, "team_usage");
    assert.equal(frame.batch[0].data.teamId, teamId);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanup(rig);
  }
});

test("a team_usage update for a DIFFERENT tenant is never delivered — tenant isolation on the WebSocket push path", { skip }, async () => {
  const rig = buildRig();
  const tenantA = `tenant-${randomUUID()}`;
  const tenantB = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantA, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard/usage/team?token=${token}` } as any);
    await rig.pubsub.publish(tenantB, "team_usage", { payload: { type: "team_usage_update", data: { teamId: "team-x", balance: { allocated: 1, consumed: 0, remaining: 1, utilizationPct: 0 } } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(client.sent.length, 0);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanup(rig);
  }
});

// AC: "all filter changes update dashboard within 2 seconds" is a REST
// re-fetch concern (frontend query-param sync), not the WebSocket push —
// this update carries only balance/burn-rate/latest-consumption (same
// deliberately-lighter-delta shape as OrgUsageUpdateMessage), which the
// frontend hook filters client-side by `teamId` since this reuses
// WO-074's tenant-wide (not team-partitioned) pub/sub channel (see
// TeamUsagePublisherService's own doc comment on this trade-off).
test("multiple teams' updates arrive on the SAME tenant-wide team_usage channel — the client is responsible for filtering by teamId", { skip }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard/usage/team?token=${token}` } as any);

    await rig.pubsub.publish(tenantId, "team_usage", { payload: { type: "team_usage_update", data: { teamId: "team-alpha", balance: { allocated: 1, consumed: 1, remaining: 0, utilizationPct: 100 } } } });
    await rig.pubsub.publish(tenantId, "team_usage", { payload: { type: "team_usage_update", data: { teamId: "team-bravo", balance: { allocated: 1, consumed: 0, remaining: 1, utilizationPct: 0 } } } });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const teamIdsReceived = client.sent.flatMap((raw) => JSON.parse(raw).batch.map((m: any) => m.data.teamId));
    assert.ok(teamIdsReceived.includes("team-alpha"));
    assert.ok(teamIdsReceived.includes("team-bravo"));
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await cleanup(rig);
  }
});
