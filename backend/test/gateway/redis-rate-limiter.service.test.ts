import { test } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { RedisRateLimiterService } from "../../src/gateway/redis-rate-limiter.service";

// Requires a real local Redis (redis-server on localhost:6379, same as
// this repo's convention of testing against a real local Postgres
// rather than mocking the database).
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

function randomKey(prefix: string): string {
  return `test:${prefix}:${Math.random().toString(36).slice(2)}`;
}

test("allows requests up to the limit, then denies the next one, atomically via Redis", { skip }, async () => {
  const limiter = new RedisRateLimiterService();
  const key = randomKey("basic");
  try {
    for (let i = 0; i < 5; i++) {
      const result = await limiter.checkAndConsume(key, 5, 1);
      assert.equal(result.allowed, true);
      assert.equal(result.remaining, 5 - (i + 1));
    }
    const sixth = await limiter.checkAndConsume(key, 5, 1);
    assert.equal(sixth.allowed, false);
    assert.equal(sixth.remaining, 0);
  } finally {
    await limiter.onModuleDestroy();
  }
});

test("the sorted-set key expires — abandoned keys don't accumulate forever", { skip }, async () => {
  const limiter = new RedisRateLimiterService();
  const key = randomKey("ttl");
  const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  try {
    await limiter.checkAndConsume(key, 5, 1);
    const ttl = await raw.pttl(key);
    assert.ok(ttl > 0 && ttl <= 2000, `expected a TTL between 0 and 2000ms (2x the 1s window), got ${ttl}`);
  } finally {
    await limiter.onModuleDestroy();
    await raw.quit();
  }
});

test("concurrent requests for the same key never exceed the limit (atomicity under real concurrency)", { skip }, async () => {
  const limiter = new RedisRateLimiterService();
  const key = randomKey("concurrent");
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.checkAndConsume(key, 10, 1)));
    const allowedCount = results.filter((r) => r.allowed).length;
    assert.equal(allowedCount, 10, "exactly 10 of the 20 concurrent requests must be allowed — no race condition double-granting capacity");
  } finally {
    await limiter.onModuleDestroy();
  }
});

test("different keys are tracked completely independently in Redis", { skip }, async () => {
  const limiter = new RedisRateLimiterService();
  const keyA = randomKey("tenant-a");
  const keyB = randomKey("tenant-b");
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal((await limiter.checkAndConsume(keyA, 2, 1)).allowed, true);
    }
    assert.equal((await limiter.checkAndConsume(keyA, 2, 1)).allowed, false);
    assert.equal((await limiter.checkAndConsume(keyB, 2, 1)).allowed, true, "tenant B must be unaffected by tenant A's exhausted limit");
  } finally {
    await limiter.onModuleDestroy();
  }
});

test("connecting to an unreachable Redis rejects quickly rather than hanging (bounded failure for the circuit breaker)", { skip }, async () => {
  const originalUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:1"; // nothing listens here
  const limiter = new RedisRateLimiterService();
  try {
    await assert.rejects(() => limiter.checkAndConsume(randomKey("unreachable"), 5, 1));
  } finally {
    await limiter.onModuleDestroy();
    if (originalUrl) process.env.REDIS_URL = originalUrl;
    else delete process.env.REDIS_URL;
  }
});
