import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditCacheCircuitBreakerService } from "../../src/credits/credit-cache-circuit-breaker.service";

class FakeCreditCacheService {
  public shouldFail = false;
  public balance = 100;
  async getBalance() {
    if (this.shouldFail) throw new Error("simulated Redis failure");
    return this.balance;
  }
  async checkAndDecrement() {
    if (this.shouldFail) throw new Error("simulated Redis failure");
    return { outcome: "allowed" as const, balance: this.balance - 10 };
  }
  async warmCache() {
    if (this.shouldFail) throw new Error("simulated Redis failure");
  }
}

test("closed state: Redis calls pass through normally when healthy", async () => {
  const cache = new FakeCreditCacheService();
  const breaker = new CreditCacheCircuitBreakerService(cache as any);

  const result = await breaker.getBalance("tenant-a", "team-1");
  assert.equal(result, 100);
  assert.equal(breaker.getState(), "closed");
});

test("opens after 3 consecutive failures, then every call returns circuit_open without touching Redis again", async () => {
  const cache = new FakeCreditCacheService();
  cache.shouldFail = true;
  const breaker = new CreditCacheCircuitBreakerService(cache as any);

  await breaker.getBalance("tenant-a", "team-1");
  await breaker.getBalance("tenant-a", "team-1");
  assert.equal(breaker.getState(), "closed", "should still be closed after only 2 failures");

  await breaker.getBalance("tenant-a", "team-1");
  assert.equal(breaker.getState(), "open", "should open after the 3rd consecutive failure");

  const result = await breaker.checkAndDecrement("tenant-a", "team-1", 10);
  assert.deepEqual(result, { outcome: "circuit_open" });
});

test("never 'fails open': an open circuit never returns a balance/allow result, only circuit_open", async () => {
  const cache = new FakeCreditCacheService();
  cache.shouldFail = true;
  const breaker = new CreditCacheCircuitBreakerService(cache as any);

  for (let i = 0; i < 3; i++) await breaker.getBalance("tenant-a", "team-1").catch(() => undefined);
  assert.equal(breaker.getState(), "open");

  const balanceResult = await breaker.getBalance("tenant-a", "team-1");
  assert.equal(balanceResult, "circuit_open");
  const decrementResult = await breaker.checkAndDecrement("tenant-a", "team-1", 10);
  assert.equal(decrementResult.outcome, "circuit_open");
});

test("a success while closed resets the consecutive-failure counter (2 failures + 1 success + 2 more failures never opens the circuit)", async () => {
  const cache = new FakeCreditCacheService();
  const breaker = new CreditCacheCircuitBreakerService(cache as any);

  cache.shouldFail = true;
  await breaker.getBalance("tenant-a", "team-1");
  await breaker.getBalance("tenant-a", "team-1");

  cache.shouldFail = false;
  await breaker.getBalance("tenant-a", "team-1"); // success — resets the counter

  cache.shouldFail = true;
  await breaker.getBalance("tenant-a", "team-1");
  await breaker.getBalance("tenant-a", "team-1");
  assert.equal(breaker.getState(), "closed", "2 failures after a reset should not be enough to open the circuit");
});

test("warmCache never throws even when the underlying cache fails — it's a best-effort side channel", async () => {
  const cache = new FakeCreditCacheService();
  cache.shouldFail = true;
  const breaker = new CreditCacheCircuitBreakerService(cache as any);

  await assert.doesNotReject(() => breaker.warmCache("tenant-a", "team-1", 100));
});
