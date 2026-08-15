import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { ConnectionRegistryService } from "../../src/websocket-gateway/connection-registry.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

function info(tenantId: string, overrides: Partial<{ userId: string; roles: string[]; channel: string }> = {}) {
  return { connectionId: randomUUID(), tenantId, userId: overrides.userId ?? "user-1", roles: overrides.roles ?? [], channel: overrides.channel ?? "dashboard" };
}

test("acquires connections up to the limit, then rejects the next one", { skip }, async () => {
  const registry = new ConnectionRegistryService();
  const tenantId = `tenant-${randomUUID()}`;
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal(await registry.acquire(info(tenantId), 3), true);
    }
    assert.equal(await registry.acquire(info(tenantId), 3), false);
  } finally {
    const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    await raw.del(`ws:tenant-connections:${tenantId}`);
    await raw.quit();
    await registry.onModuleDestroy();
  }
});

test("releasing a connection frees capacity for a new one", { skip }, async () => {
  const registry = new ConnectionRegistryService();
  const tenantId = `tenant-${randomUUID()}`;
  try {
    const first = info(tenantId);
    assert.equal(await registry.acquire(first, 1), true);
    assert.equal(await registry.acquire(info(tenantId), 1), false);

    await registry.release(first.connectionId);
    assert.equal(await registry.acquire(info(tenantId), 1), true);
  } finally {
    const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    await raw.del(`ws:tenant-connections:${tenantId}`);
    await raw.quit();
    await registry.onModuleDestroy();
  }
});

test("different tenants have completely independent connection limits", { skip }, async () => {
  const registry = new ConnectionRegistryService();
  const tenantA = `tenant-${randomUUID()}`;
  const tenantB = `tenant-${randomUUID()}`;
  try {
    assert.equal(await registry.acquire(info(tenantA), 1), true);
    assert.equal(await registry.acquire(info(tenantA), 1), false, "tenant A is now at its limit");
    assert.equal(await registry.acquire(info(tenantB), 1), true, "tenant B must be unaffected by tenant A's exhausted limit");
  } finally {
    const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    await raw.del(`ws:tenant-connections:${tenantA}`, `ws:tenant-connections:${tenantB}`);
    await raw.quit();
    await registry.onModuleDestroy();
  }
});

test("concurrent acquire attempts never exceed the limit (atomicity under real concurrency)", { skip }, async () => {
  const registry = new ConnectionRegistryService();
  const tenantId = `tenant-${randomUUID()}`;
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => registry.acquire(info(tenantId), 10)));
    const acquiredCount = results.filter(Boolean).length;
    assert.equal(acquiredCount, 10, "exactly 10 of the 20 concurrent attempts must succeed — no race condition over-granting capacity");
  } finally {
    const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    await raw.del(`ws:tenant-connections:${tenantId}`);
    await raw.quit();
    await registry.onModuleDestroy();
  }
});

test("tracks local connections and exposes the per-tenant local count", { skip }, async () => {
  const registry = new ConnectionRegistryService();
  const tenantId = `tenant-${randomUUID()}`;
  try {
    const a = info(tenantId);
    const b = info(tenantId);
    await registry.acquire(a, 10);
    await registry.acquire(b, 10);

    assert.equal(registry.getLocalConnectionCount(tenantId), 2);
    assert.deepEqual(registry.getLocalConnection(a.connectionId)?.connectionId, a.connectionId);

    await registry.release(a.connectionId);
    assert.equal(registry.getLocalConnectionCount(tenantId), 1);
    assert.equal(registry.getLocalConnection(a.connectionId), undefined);
  } finally {
    const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    await raw.del(`ws:tenant-connections:${tenantId}`);
    await raw.quit();
    await registry.onModuleDestroy();
  }
});

test("releasing an unknown connectionId is a safe no-op", { skip }, async () => {
  const registry = new ConnectionRegistryService();
  await assert.doesNotReject(() => registry.release("never-acquired"));
  await registry.onModuleDestroy();
});
