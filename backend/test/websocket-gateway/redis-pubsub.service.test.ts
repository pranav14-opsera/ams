import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

function waitFor<T>(getValue: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const value = getValue();
      if (value !== undefined) {
        clearInterval(interval);
        resolve(value);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("timed out waiting for message"));
      }
    }, 20);
  });
}

test("a message published to a tenant channel is delivered to a subscriber on that same tenant+channel", { skip }, async () => {
  const pubsub = new RedisPubSubService();
  const tenantId = `tenant-${randomUUID()}`;
  let received: unknown;

  try {
    await pubsub.subscribe(tenantId, "dashboard", (msg) => { received = msg; });
    await pubsub.publish(tenantId, "dashboard", { hello: "world" });

    const result = await waitFor(() => received);
    assert.deepEqual(result, { hello: "world" });
  } finally {
    await pubsub.onModuleDestroy();
  }
});

test("a message published to a DIFFERENT tenant's channel is never delivered (tenant isolation)", { skip }, async () => {
  const pubsub = new RedisPubSubService();
  const tenantA = `tenant-${randomUUID()}`;
  const tenantB = `tenant-${randomUUID()}`;
  let receivedByA: unknown;

  try {
    await pubsub.subscribe(tenantA, "dashboard", (msg) => { receivedByA = msg; });
    await pubsub.publish(tenantB, "dashboard", { hello: "wrong tenant" });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(receivedByA, undefined, "tenant A must never see tenant B's message");
  } finally {
    await pubsub.onModuleDestroy();
  }
});

test("a message published to a DIFFERENT channel for the same tenant is never delivered (channel isolation)", { skip }, async () => {
  const pubsub = new RedisPubSubService();
  const tenantId = `tenant-${randomUUID()}`;
  let receivedOnDashboard: unknown;

  try {
    await pubsub.subscribe(tenantId, "dashboard", (msg) => { receivedOnDashboard = msg; });
    await pubsub.publish(tenantId, "alerts", { hello: "wrong channel" });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(receivedOnDashboard, undefined);
  } finally {
    await pubsub.onModuleDestroy();
  }
});

test("multiple handlers on the same tenant+channel all receive the message", { skip }, async () => {
  const pubsub = new RedisPubSubService();
  const tenantId = `tenant-${randomUUID()}`;
  let receivedA: unknown;
  let receivedB: unknown;

  try {
    await pubsub.subscribe(tenantId, "dashboard", (msg) => { receivedA = msg; });
    await pubsub.subscribe(tenantId, "dashboard", (msg) => { receivedB = msg; });
    await pubsub.publish(tenantId, "dashboard", { fan: "out" });

    await waitFor(() => receivedA);
    await waitFor(() => receivedB);
    assert.deepEqual(receivedA, { fan: "out" });
    assert.deepEqual(receivedB, { fan: "out" });
  } finally {
    await pubsub.onModuleDestroy();
  }
});

test("after unsubscribe, a handler no longer receives messages", { skip }, async () => {
  const pubsub = new RedisPubSubService();
  const tenantId = `tenant-${randomUUID()}`;
  let received: unknown;
  const handler = (msg: unknown) => { received = msg; };

  try {
    await pubsub.subscribe(tenantId, "dashboard", handler);
    await pubsub.unsubscribe(tenantId, "dashboard", handler);
    await pubsub.publish(tenantId, "dashboard", { should: "not arrive" });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received, undefined);
  } finally {
    await pubsub.onModuleDestroy();
  }
});
