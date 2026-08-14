import { test } from "node:test";
import assert from "node:assert/strict";
import type { Producer } from "kafkajs";
import { buildDeploymentEvent, publishDeploymentEvent } from "../publish-deployment-event";

test("buildDeploymentEvent produces the expected schema", () => {
  const fixedNow = () => new Date("2026-08-14T12:00:00.000Z");
  const event = buildDeploymentEvent({
    eventType: "canary-begin",
    service: "ams-backend",
    version: "abc1234",
    environment: "production",
    actor: "forge-pipeline",
    now: fixedNow,
  });
  assert.deepEqual(event, {
    eventType: "canary-begin",
    service: "ams-backend",
    version: "abc1234",
    environment: "production",
    actor: "forge-pipeline",
    timestamp: "2026-08-14T12:00:00.000Z",
  });
});

test("buildDeploymentEvent rejects an unknown event type", () => {
  assert.throws(
    () =>
      buildDeploymentEvent({
        // @ts-expect-error deliberately invalid input
        eventType: "canary-succeeded",
        service: "ams-backend",
        version: "abc1234",
        environment: "production",
        actor: "forge-pipeline",
      }),
    /Unknown deployment event type/,
  );
});

test("buildDeploymentEvent rejects missing required fields", () => {
  assert.throws(
    () =>
      buildDeploymentEvent({
        eventType: "start",
        service: "",
        version: "abc1234",
        environment: "production",
        actor: "forge-pipeline",
      }),
    /required/,
  );
});

test("publishDeploymentEvent sends to audit-events keyed by service name", async () => {
  const sent: Array<{ topic: string; messages: Array<{ key: unknown; value: unknown }> }> = [];
  const fakeProducer = {
    send: async (record: { topic: string; messages: Array<{ key: unknown; value: unknown }> }) => {
      sent.push(record);
      return [];
    },
  } as unknown as Producer;

  const event = buildDeploymentEvent({
    eventType: "rollback",
    service: "ams-frontend",
    version: "def5678",
    environment: "production",
    actor: "argo-rollouts-controller",
    now: () => new Date("2026-08-14T12:05:00.000Z"),
  });

  await publishDeploymentEvent(fakeProducer, event);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, "audit-events");
  assert.equal(sent[0].messages.length, 1);
  assert.equal(sent[0].messages[0].key, "ams-frontend");
  assert.deepEqual(JSON.parse(sent[0].messages[0].value as string), event);
});
