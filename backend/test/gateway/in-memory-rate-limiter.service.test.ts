import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRateLimiterService } from "../../src/gateway/in-memory-rate-limiter.service";

test("allows requests up to the limit, then denies the next one", async () => {
  const limiter = new InMemoryRateLimiterService();
  const key = `k-${Math.random()}`;

  for (let i = 0; i < 5; i++) {
    const result = await limiter.checkAndConsume(key, 5, 1);
    assert.equal(result.allowed, true, `request ${i + 1} of 5 should be allowed`);
    assert.equal(result.remaining, 5 - (i + 1));
  }

  const sixth = await limiter.checkAndConsume(key, 5, 1);
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.remaining, 0);
});

test("allows requests again once the window slides past the oldest entries", async () => {
  const limiter = new InMemoryRateLimiterService();
  const key = `k-${Math.random()}`;

  for (let i = 0; i < 3; i++) {
    assert.equal((await limiter.checkAndConsume(key, 3, 1)).allowed, true);
  }
  assert.equal((await limiter.checkAndConsume(key, 3, 1)).allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 1100));

  assert.equal((await limiter.checkAndConsume(key, 3, 1)).allowed, true, "the 1-second window must have slid past the earlier requests");
});

test("different keys are tracked completely independently", async () => {
  const limiter = new InMemoryRateLimiterService();
  const keyA = `a-${Math.random()}`;
  const keyB = `b-${Math.random()}`;

  for (let i = 0; i < 2; i++) {
    assert.equal((await limiter.checkAndConsume(keyA, 2, 1)).allowed, true);
  }
  assert.equal((await limiter.checkAndConsume(keyA, 2, 1)).allowed, false, "key A must now be exhausted");
  assert.equal((await limiter.checkAndConsume(keyB, 2, 1)).allowed, true, "key B must be completely unaffected by key A's usage — one tenant hitting its limit must not affect any other tenant's capacity");
});

test("resetAt is approximately now + windowSeconds", async () => {
  const limiter = new InMemoryRateLimiterService();
  const before = Date.now();
  const result = await limiter.checkAndConsume(`k-${Math.random()}`, 10, 5);
  const after = Date.now();

  assert.ok(result.resetAt.getTime() >= before + 5000);
  assert.ok(result.resetAt.getTime() <= after + 5000);
});
