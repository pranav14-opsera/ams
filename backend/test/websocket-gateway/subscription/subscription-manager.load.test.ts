import { test } from "node:test";
import assert from "node:assert/strict";
import { JwtKeyService } from "../../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../../src/auth/jwt/multi-key-jwt-verifier.service";
import { ChannelPermissionsService } from "../../../src/websocket-gateway/subscription/channel-permissions.service";
import { SubscriptionManagerService } from "../../../src/websocket-gateway/subscription/subscription-manager.service";
import { SubscriptionRegistryService } from "../../../src/websocket-gateway/subscription/subscription-registry.service";

const TENANT_COUNT = 10;
const CONNECTIONS_PER_TENANT = 50;
const MESSAGES_PER_SECOND = 100;
const DURATION_SECONDS = 10;

function percentile(sortedMs: number[], p: number): number {
  const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[index];
}

/**
 * 500 mock connections (50 per tenant across 10 tenants), 100 messages/sec
 * for 10 simulated seconds (1000 total fan-outs). fanOutMessage is
 * synchronous in-process work — no real per-message network I/O to wait
 * on — so this measures actual CPU time per fan-out call rather than
 * sleeping through 10 real wall-clock seconds; that's the part this WO's
 * acceptance criteria ("fan-out latency stays under 10ms at P99") is
 * actually about.
 */
test("500 connections across 10 tenants: P99 per-tenant fan-out latency stays under 10ms, zero cross-tenant leakage", async () => {
  const keyService = new JwtKeyService();
  const verifier = new MultiKeyJwtVerifier(keyService);
  const registry = new SubscriptionRegistryService();
  const channelPermissions = new ChannelPermissionsService();
  const manager = new SubscriptionManagerService(verifier, registry, channelPermissions);

  const deliveryLog: Array<{ userId: string; tenantId: string; eventTenantId: string }> = [];
  let currentEventTenantId = "";

  for (let t = 0; t < TENANT_COUNT; t++) {
    const tenantId = `tenant-${t}`;
    for (let c = 0; c < CONNECTIONS_PER_TENANT; c++) {
      const userId = `${tenantId}-user-${c}`;
      const token = keyService.sign({ tid: tenantId, roles: ["agent_operator"], permissions: [] }, userId, 900);
      const session = await manager.authenticateConnection(token, () => {
        deliveryLog.push({ userId, tenantId, eventTenantId: currentEventTenantId });
      });
      manager.handleSubscribe(session, tenantId, "agent-health");
    }
  }

  const totalEvents = MESSAGES_PER_SECOND * DURATION_SECONDS;
  const latenciesMs: number[] = [];

  for (let i = 0; i < totalEvents; i++) {
    const tenantId = `tenant-${i % TENANT_COUNT}`;
    currentEventTenantId = tenantId;

    const startedAt = process.hrtime.bigint();
    manager.fanOutMessage(tenantId, "agent-health", { seq: i });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    latenciesMs.push(elapsedMs);
  }

  latenciesMs.sort((a, b) => a - b);
  const p99 = percentile(latenciesMs, 99);
  assert.ok(p99 < 10, `P99 fan-out latency was ${p99}ms, expected under 10ms`);

  assert.equal(deliveryLog.length, totalEvents * CONNECTIONS_PER_TENANT, "every event must reach exactly its own tenant's 50 subscribers");
  const leaks = deliveryLog.filter((entry) => entry.tenantId !== entry.eventTenantId);
  assert.equal(leaks.length, 0, `expected zero cross-tenant leakage, found ${leaks.length}`);
});
