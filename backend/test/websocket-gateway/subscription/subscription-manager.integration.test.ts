import { test } from "node:test";
import assert from "node:assert/strict";
import { JwtKeyService } from "../../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../../src/auth/jwt/multi-key-jwt-verifier.service";
import { ChannelPermissionsService } from "../../../src/websocket-gateway/subscription/channel-permissions.service";
import { KafkaConsumerBridgeService } from "../../../src/websocket-gateway/subscription/kafka-consumer-bridge.service";
import { SubscriptionManagerService } from "../../../src/websocket-gateway/subscription/subscription-manager.service";
import { SubscriptionRegistryService } from "../../../src/websocket-gateway/subscription/subscription-registry.service";
import type { KafkaEventEnvelope } from "../../../src/websocket-gateway/subscription/subscription.types";
import kafkaEventFixtures from "../../fixtures/subscriptions/kafka-events.json";
import userSessionFixtures from "../../fixtures/subscriptions/user-sessions.json";

/**
 * End-to-end test with a mock Kafka consumer (KafkaConsumerBridgeService.process,
 * invoked directly per this codebase's documented in-process substitution —
 * see the bridge's own doc comment) and 5 mock WebSocket clients (one per
 * fixture role, across 2 tenants) that produces 50 events across every
 * channel and verifies each client received exactly the events it should
 * have, with an explicit assertion that zero cross-tenant messages were
 * ever delivered.
 */
test("fans out 50 mixed-channel events to exactly the correct subscribers, with zero cross-tenant leakage", async () => {
  const keyService = new JwtKeyService();
  const verifier = new MultiKeyJwtVerifier(keyService);
  const registry = new SubscriptionRegistryService();
  const channelPermissions = new ChannelPermissionsService();
  const manager = new SubscriptionManagerService(verifier, registry, channelPermissions);
  const bridge = new KafkaConsumerBridgeService(manager);

  const receivedByUser = new Map<string, unknown[]>();
  const sessionsByFixtureKey: Record<string, Awaited<ReturnType<typeof manager.authenticateConnection>>> = {};

  for (const [fixtureKey, claims] of Object.entries(userSessionFixtures) as Array<[string, any]>) {
    if (fixtureKey === "description") continue;
    const token = keyService.sign({ tid: claims.tid, roles: claims.roles, permissions: claims.permissions }, claims.sub, 900);
    receivedByUser.set(claims.sub, []);
    const session = await manager.authenticateConnection(token, (payload) => receivedByUser.get(claims.sub)!.push(payload));
    sessionsByFixtureKey[fixtureKey] = session;
  }

  // Every user subscribes to every non-PHI channel within their own tenant; only the two tenant-a
  // users with the PHI permission additionally subscribe to phi-access.
  for (const [fixtureKey, session] of Object.entries(sessionsByFixtureKey)) {
    for (const channel of ["agent-health", "credit-balance", "alerts"]) {
      manager.handleSubscribe(session, session.tenantId, channel);
    }
    if (fixtureKey === "tenant-a-platform-admin" || fixtureKey === "tenant-a-compliance-officer") {
      manager.handleSubscribe(session, session.tenantId, "phi-access");
    }
  }

  const eventTemplates: KafkaEventEnvelope[] = [
    kafkaEventFixtures["agent-health-event"] as KafkaEventEnvelope,
    kafkaEventFixtures["credit-balance-event"] as KafkaEventEnvelope,
    kafkaEventFixtures["alert-event"] as KafkaEventEnvelope,
    kafkaEventFixtures["phi-access-event"] as KafkaEventEnvelope,
  ];

  const expectedCountsByUser = new Map<string, number>([...receivedByUser.keys()].map((userId) => [userId, 0]));
  for (let i = 0; i < 50; i++) {
    const template = eventTemplates[i % eventTemplates.length];
    const event: KafkaEventEnvelope = { ...template, payload: { ...(template.payload as object), seq: i } };
    bridge.process(event);

    for (const session of Object.values(sessionsByFixtureKey)) {
      const shouldReceive = session.tenantId === event.tenantId && session.subscribedChannels.has(event.channel);
      if (shouldReceive) expectedCountsByUser.set(session.userId, (expectedCountsByUser.get(session.userId) ?? 0) + 1);
    }
  }

  for (const [userId, expectedCount] of expectedCountsByUser) {
    assert.equal(receivedByUser.get(userId)?.length, expectedCount, `user ${userId} received the wrong number of events`);
  }

  // Explicit cross-tenant leakage assertion: no tenant-b user ever appears
  // as a recipient of a tenant-a event and vice versa, checked directly
  // against every delivered payload rather than trusting the count match alone.
  const tenantAUsers = new Set(["user-a1", "user-a2", "user-a3"]);
  const tenantBUsers = new Set(["user-b1", "user-b2"]);
  for (let i = 0; i < 50; i++) {
    const template = eventTemplates[i % eventTemplates.length];
    if (template.tenantId === "tenant-a") {
      for (const userId of tenantBUsers) {
        const payloads = receivedByUser.get(userId) ?? [];
        assert.ok(!payloads.some((p: any) => p.seq === i), `tenant-b user ${userId} must never receive tenant-a event #${i}`);
      }
    } else {
      for (const userId of tenantAUsers) {
        const payloads = receivedByUser.get(userId) ?? [];
        assert.ok(!payloads.some((p: any) => p.seq === i), `tenant-a user ${userId} must never receive tenant-b event #${i}`);
      }
    }
  }
});

test("a malformed Kafka envelope (missing tenantId) is dropped, never fanned out, and reported as an error", () => {
  const keyService = new JwtKeyService();
  const verifier = new MultiKeyJwtVerifier(keyService);
  const registry = new SubscriptionRegistryService();
  const channelPermissions = new ChannelPermissionsService();
  const manager = new SubscriptionManagerService(verifier, registry, channelPermissions);
  const bridge = new KafkaConsumerBridgeService(manager);

  const result = bridge.process(kafkaEventFixtures["malformed-event"] as unknown as KafkaEventEnvelope);

  assert.equal(result.delivered.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error, "malformed_envelope");
});
