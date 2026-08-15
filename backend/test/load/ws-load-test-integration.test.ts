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
import { LATENCY_BUDGETS_P99_MS } from "./latency-budgets";
import { computeSegmentStats } from "./latency-stats";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

class TestGateway extends BaseRealtimeGateway {
  protected readonly channel = "dashboard";
}

/** Same minimal fake as base-realtime.gateway.test.ts's own — matches the real `ws` surface BaseRealtimeGateway uses. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  received: Array<{ receivedAtMs: number; frame: any }> = [];

  send(data: string): void {
    this.received.push({ receivedAtMs: Date.now(), frame: JSON.parse(data) });
  }
  close(): void {
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
  const gateway = new TestGateway(authService, registry, pubsub, batcher, metrics, limitConfig);
  return { keyService, gateway, registry, pubsub, batcher, metrics };
}

/**
 * WO-044's "TimescaleDB -> WebSocket push" segment, measured genuinely
 * (real Redis pub/sub, real BaseRealtimeGateway, real 100ms batching) —
 * this is the one Kafka-adjacent segment that doesn't require a broker at
 * all, so it's tested for real rather than documented as unverifiable.
 * Each published message embeds its own publish timestamp; delivery
 * latency is measured as receipt time (FakeSocket.send is called
 * synchronously from the batcher's flush) minus that publish timestamp.
 */
test("load test: N messages published in rapid succession are all delivered within the websocket_delivery P99 budget", { skip, timeout: 30_000 }, async () => {
  const rig = buildRig();
  const tenantId = `tenant-${randomUUID()}`;
  const token = rig.keyService.sign({ tid: tenantId, roles: ["platform_admin"] }, "user-1", 900);
  const client = new FakeSocket();

  const MESSAGE_COUNT = 50;

  try {
    await rig.gateway.handleConnection(client as any, { url: `/ws/dashboard?token=${token}` } as any);

    const publishedAtByIndex: number[] = [];
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      publishedAtByIndex.push(Date.now());
      await rig.pubsub.publish(tenantId, "dashboard", { payload: { seq: i } });
      await new Promise((resolve) => setTimeout(resolve, 5)); // stagger publishes across several 100ms batch windows
    }

    // Give the last batch window time to flush.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const allDeliveredSeqs = client.received.flatMap((r) => r.frame.batch.map((item: any) => item.seq));
    assert.equal(new Set(allDeliveredSeqs).size, MESSAGE_COUNT, "every published message must eventually be delivered (batched, but none dropped)");

    // Per-batch-frame delivery latency: frame received time minus the
    // publish time of the LATEST message in that batch (the batch as a
    // whole couldn't have flushed before its newest member was published).
    const latencies: number[] = [];
    for (const { receivedAtMs, frame } of client.received) {
      const seqsInFrame: number[] = frame.batch.map((item: any) => item.seq);
      const latestPublishedAt = Math.max(...seqsInFrame.map((seq) => publishedAtByIndex[seq]));
      latencies.push(receivedAtMs - latestPublishedAt);
    }

    const stats = computeSegmentStats(latencies);
    console.log(`websocket_delivery: P50=${stats.p50.toFixed(1)}ms P95=${stats.p95.toFixed(1)}ms P99=${stats.p99.toFixed(1)}ms over ${stats.count} batch frames (budget: ${LATENCY_BUDGETS_P99_MS.websocket_delivery}ms)`);
    assert.ok(stats.p99 <= LATENCY_BUDGETS_P99_MS.websocket_delivery, `websocket_delivery P99 was ${stats.p99}ms, exceeding the ${LATENCY_BUDGETS_P99_MS.websocket_delivery}ms budget`);
  } finally {
    await rig.gateway.handleDisconnect(client as any);
    await rig.registry.onModuleDestroy();
    await rig.pubsub.onModuleDestroy();
  }
});
