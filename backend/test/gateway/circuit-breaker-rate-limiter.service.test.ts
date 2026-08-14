import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreakerRateLimiterService } from "../../src/gateway/circuit-breaker-rate-limiter.service";
import { InMemoryRateLimiterService } from "../../src/gateway/in-memory-rate-limiter.service";
import { RateLimitMetricsService } from "../../src/gateway/rate-limit-metrics.service";
import type { RateLimiterPort } from "../../src/gateway/rate-limiter.port";

function alwaysFailingRedis(): RateLimiterPort {
  return { checkAndConsume: async () => { throw new Error("ECONNREFUSED"); } };
}

function alwaysSucceedingRedis(remaining = 999): RateLimiterPort {
  return { checkAndConsume: async () => ({ allowed: true, limit: 1000, remaining, resetAt: new Date(Date.now() + 1000) }) };
}

test("uses Redis directly while the circuit is closed", async () => {
  const breaker = new CircuitBreakerRateLimiterService(alwaysSucceedingRedis(500), new InMemoryRateLimiterService(), new RateLimitMetricsService());
  const result = await breaker.checkAndConsume("k1", 1000, 1);
  assert.equal(result.remaining, 500);
  assert.equal(breaker.getState(), "closed");
});

test("opens the circuit after 3 consecutive Redis failures, and falls back to a conservative in-memory limit", async () => {
  const breaker = new CircuitBreakerRateLimiterService(alwaysFailingRedis(), new InMemoryRateLimiterService(), new RateLimitMetricsService());

  await breaker.checkAndConsume("k2", 100, 1);
  await breaker.checkAndConsume("k2", 100, 1);
  assert.equal(breaker.getState(), "closed", "must not open before the 3rd failure");
  await breaker.checkAndConsume("k2", 100, 1);
  assert.equal(breaker.getState(), "open", "must open exactly at the 3rd consecutive failure");
});

test("never fails open: while the circuit is open, requests are still checked against a real (conservative) limit, not unconditionally allowed", async () => {
  const breaker = new CircuitBreakerRateLimiterService(alwaysFailingRedis(), new InMemoryRateLimiterService(), new RateLimitMetricsService());
  const key = "k3";

  for (let i = 0; i < 3; i++) await breaker.checkAndConsume(key, 10, 1); // trip the breaker (uses the fallback at 50% = 5 for these first 3 too)
  assert.equal(breaker.getState(), "open");

  // Fallback limit is 50% of 10 = 5. 3 already consumed above, so 2 more should be allowed, then denied.
  assert.equal((await breaker.checkAndConsume(key, 10, 1)).allowed, true);
  assert.equal((await breaker.checkAndConsume(key, 10, 1)).allowed, true);
  const denied = await breaker.checkAndConsume(key, 10, 1);
  assert.equal(denied.allowed, false, "the fallback tier must still genuinely enforce a (reduced) limit — never fail open, per OWASP A10");
});

test("does not re-attempt Redis before the reset window elapses", async () => {
  let callCount = 0;
  const countingFailingRedis: RateLimiterPort = { checkAndConsume: async () => { callCount++; throw new Error("down"); } };
  const breaker = new CircuitBreakerRateLimiterService(countingFailingRedis, new InMemoryRateLimiterService(), new RateLimitMetricsService());

  for (let i = 0; i < 3; i++) await breaker.checkAndConsume("k4", 10, 1);
  assert.equal(callCount, 3);

  await breaker.checkAndConsume("k4", 10, 1);
  await breaker.checkAndConsume("k4", 10, 1);
  assert.equal(callCount, 3, "while open and before the reset window, Redis must not be called again at all");
});

test("half-open probe: after the reset window, a successful Redis call closes the circuit again", async () => {
  const metrics = new RateLimitMetricsService();
  let shouldFail = true;
  const flakyRedis: RateLimiterPort = {
    checkAndConsume: async () => {
      if (shouldFail) throw new Error("still down");
      return { allowed: true, limit: 10, remaining: 9, resetAt: new Date(Date.now() + 1000) };
    },
  };
  const breaker = new CircuitBreakerRateLimiterService(flakyRedis, new InMemoryRateLimiterService(), metrics);
  breaker["consecutiveFailures"] = 3;
  breaker["state"] = "open";
  breaker["openedAt"] = Date.now() - 31_000;

  shouldFail = false;
  const result = await breaker.checkAndConsume("k5", 10, 1);
  assert.equal(result.allowed, true);
  assert.equal(breaker.getState(), "closed", "a successful half-open probe must close the circuit");
});

test("a failed half-open probe re-opens the circuit immediately", async () => {
  const breaker = new CircuitBreakerRateLimiterService(alwaysFailingRedis(), new InMemoryRateLimiterService(), new RateLimitMetricsService());
  breaker["consecutiveFailures"] = 3;
  breaker["state"] = "open";
  breaker["openedAt"] = Date.now() - 31_000;

  await breaker.checkAndConsume("k6", 10, 1);
  assert.equal(breaker.getState(), "open", "a failed half-open probe must re-open the circuit, not stay half-open or close");
});
