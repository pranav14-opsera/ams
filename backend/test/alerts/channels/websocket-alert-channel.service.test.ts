import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketAlertChannelService } from "../../../src/alerts/channels/websocket-alert-channel.service";
import type { AlertEvent } from "../../../src/alerts/alert-threshold.types";

class FakePubSub {
  public published: Array<{ tenantId: string; channel: string; message: unknown }> = [];
  async publish(tenantId: string, channel: string, message: unknown) {
    this.published.push({ tenantId, channel, message });
  }
}

function makeAlertEvent(): AlertEvent {
  return {
    id: "event-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    metricName: "error_rate",
    thresholdValue: 0.05,
    actualValue: 0.9,
    severity: "critical",
    breachTimestamp: new Date("2026-08-16T00:00:00Z"),
    detectionMethod: "threshold",
    statisticalEvidence: null,
  };
}

test("publishes to the tenant's own 'alerts' channel", async () => {
  const pubsub = new FakePubSub();
  const channel = new WebSocketAlertChannelService(pubsub as any);

  const result = await channel.deliver(makeAlertEvent(), {});
  assert.equal(result.status, "sent");
  assert.equal(pubsub.published.length, 1);
  assert.equal(pubsub.published[0].tenantId, "tenant-a");
  assert.equal(pubsub.published[0].channel, "alerts");
});

test("targets platform_admin and team_lead via requiredRoles, matching BaseRealtimeGateway's role-filter mechanism", async () => {
  const pubsub = new FakePubSub();
  const channel = new WebSocketAlertChannelService(pubsub as any);

  await channel.deliver(makeAlertEvent(), {});
  const message = pubsub.published[0].message as { requiredRoles: string[] };
  assert.deepEqual(message.requiredRoles.sort(), ["platform_admin", "team_lead"]);
});

test("the alert event itself is the message payload, unmodified", async () => {
  const pubsub = new FakePubSub();
  const channel = new WebSocketAlertChannelService(pubsub as any);
  const alertEvent = makeAlertEvent();

  await channel.deliver(alertEvent, {});
  const message = pubsub.published[0].message as { payload: AlertEvent };
  assert.deepEqual(message.payload, alertEvent);
});

test("a publish failure is reported as 'failed' with the real error message", async () => {
  const pubsub = { publish: async () => { throw new Error("redis unavailable"); } };
  const channel = new WebSocketAlertChannelService(pubsub as any);

  const result = await channel.deliver(makeAlertEvent(), {});
  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "redis unavailable");
});
