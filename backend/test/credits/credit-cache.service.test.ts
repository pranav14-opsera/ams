import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditCacheService } from "../../src/credits/credit-cache.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

function uniqueTenant(): string {
  return `test-tenant-${Math.random().toString(36).slice(2, 8)}`;
}

test("real Redis: warmCache then checkAndDecrement allows and atomically decrements when sufficient", { skip }, async () => {
  const cache = new CreditCacheService();
  const tenantId = uniqueTenant();
  try {
    await cache.warmCache(tenantId, "team-1", 100);
    const result = await cache.checkAndDecrement(tenantId, "team-1", 30);
    assert.deepEqual(result, { outcome: "allowed", balance: 70 });

    const balance = await cache.getBalance(tenantId, "team-1");
    assert.equal(balance, 70);
  } finally {
    await cache.invalidateBalance(tenantId, "team-1");
    await cache.onModuleDestroy();
  }
});

test("real Redis: checkAndDecrement denies (and leaves the balance untouched) when the cost exceeds the balance", { skip }, async () => {
  const cache = new CreditCacheService();
  const tenantId = uniqueTenant();
  try {
    await cache.warmCache(tenantId, "team-1", 20);
    const result = await cache.checkAndDecrement(tenantId, "team-1", 30);
    assert.deepEqual(result, { outcome: "denied", balance: 20 });

    const balance = await cache.getBalance(tenantId, "team-1");
    assert.equal(balance, 20, "a denied check must never decrement the balance");
  } finally {
    await cache.invalidateBalance(tenantId, "team-1");
    await cache.onModuleDestroy();
  }
});

test("real Redis: checkAndDecrement reports cache_miss when no balance has ever been warmed for this key", { skip }, async () => {
  const cache = new CreditCacheService();
  const tenantId = uniqueTenant();
  try {
    const result = await cache.checkAndDecrement(tenantId, "team-1", 10);
    assert.deepEqual(result, { outcome: "cache_miss" });
  } finally {
    await cache.onModuleDestroy();
  }
});

test("real Redis: 50 genuinely concurrent checkAndDecrement calls against the same key never over-decrement past zero", { skip }, async () => {
  const cache = new CreditCacheService();
  const tenantId = uniqueTenant();
  try {
    await cache.warmCache(tenantId, "team-1", 500); // exactly enough for 50 x 10-credit decrements

    const results = await Promise.all(Array.from({ length: 60 }, () => cache.checkAndDecrement(tenantId, "team-1", 10)));
    const allowed = results.filter((r) => r.outcome === "allowed");
    const denied = results.filter((r) => r.outcome === "denied");

    assert.equal(allowed.length, 50, "exactly 50 of the 60 concurrent attempts should be allowed (500 / 10)");
    assert.equal(denied.length, 10);

    const finalBalance = await cache.getBalance(tenantId, "team-1");
    assert.equal(finalBalance, 0, "the balance should land at exactly 0, never negative, despite 60 concurrent racers");
  } finally {
    await cache.invalidateBalance(tenantId, "team-1");
    await cache.onModuleDestroy();
  }
});

test("real Redis: invalidateBalance clears the key so a subsequent check reports cache_miss", { skip }, async () => {
  const cache = new CreditCacheService();
  const tenantId = uniqueTenant();
  try {
    await cache.warmCache(tenantId, "team-1", 100);
    await cache.invalidateBalance(tenantId, "team-1");
    const balance = await cache.getBalance(tenantId, "team-1");
    assert.equal(balance, null);
  } finally {
    await cache.onModuleDestroy();
  }
});
