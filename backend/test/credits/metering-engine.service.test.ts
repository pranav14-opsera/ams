import { test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";
import { MeteringEngineService } from "../../src/credits/metering-engine.service";

class FakeRateMappingService {
  public rate: number | null = 10;
  public hardCap: number | null = null;
  async getRate() {
    return this.rate;
  }
  async getHardCap() {
    return this.hardCap;
  }
}

class FakeCacheBreaker {
  public balance: number | null | "circuit_open" = 1000;
  public decrementResult: { outcome: "cache_miss" } | { outcome: "denied"; balance: number } | { outcome: "allowed"; balance: number } | { outcome: "circuit_open" } = { outcome: "allowed", balance: 990 };
  public warmed: Array<{ tenantId: string; teamId: string | null; balance: number }> = [];
  async getBalance() {
    return this.balance;
  }
  async checkAndDecrement() {
    return this.decrementResult;
  }
  async warmCache(tenantId: string, teamId: string | null, balance: number) {
    this.warmed.push({ tenantId, teamId, balance });
  }
}

class FakeLedgerService {
  public balance = { tenantId: "tenant-a", teamId: "team-1", netBalance: 1000, transactionCount: 1, lastTransactionAt: new Date() };
  public recorded: unknown[] = [];
  async getBalance() {
    return this.balance;
  }
  async recordTransaction(_client: unknown, tenantId: string, request: Record<string, unknown>) {
    const newBalance = this.balance.netBalance - (request.amount as number);
    const transaction = { id: `txn-${this.recorded.length + 1}`, tenantId, runningBalance: newBalance, ...request };
    this.recorded.push(transaction);
    return transaction;
  }
}

class FakeKafkaProducer {
  public published: unknown[] = [];
  async publish(event: unknown) {
    this.published.push(event);
  }
}

function buildRig() {
  const rateMappingService = new FakeRateMappingService();
  const cacheBreaker = new FakeCacheBreaker();
  const ledgerService = new FakeLedgerService();
  const kafkaProducer = new FakeKafkaProducer();
  const engine = new MeteringEngineService(rateMappingService as any, cacheBreaker as any, ledgerService as any, kafkaProducer as any);
  return { rateMappingService, cacheBreaker, ledgerService, kafkaProducer, engine };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return { tenantId: "tenant-a", teamId: "team-1", agentId: "agent-1", actionType: "tool_call", ...overrides };
}

test("cache hit allow: sufficient cached balance, well clear of any hard cap, decrements atomically", async () => {
  const { cacheBreaker, kafkaProducer, engine } = buildRig();
  cacheBreaker.balance = 1000;
  cacheBreaker.decrementResult = { outcome: "allowed", balance: 990 };

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "allowed");
  assert.equal(result.enforcementMode, "cache");
  assert.equal(result.creditsConsumed, 10);
  assert.equal(result.balanceAfter, 990);
  assert.equal(kafkaProducer.published.length, 1);
});

test("cache hit deny: the peeked balance is already insufficient — denied immediately without touching the ledger", async () => {
  const { cacheBreaker, ledgerService, engine } = buildRig();
  cacheBreaker.balance = 5; // less than the cost (10)

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "denied");
  assert.equal(result.enforcementMode, "cache");
  assert.equal(ledgerService.recorded.length, 0, "the ledger should never be touched for a clear cache-hit deny");
});

test("cache hit deny at the atomic-decrement step (TOCTOU): peek looked fine but the atomic Lua check denies", async () => {
  const { cacheBreaker, engine } = buildRig();
  cacheBreaker.balance = 1000; // peek says plenty
  cacheBreaker.decrementResult = { outcome: "denied", balance: 3 }; // but the atomic check says otherwise

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "denied");
  assert.equal(result.enforcementMode, "cache");
  assert.equal(result.balanceAfter, 3);
});

test("WO-070: a denial with a zero/negative current balance carries hardCapReached: true", async () => {
  const { cacheBreaker, engine } = buildRig();
  cacheBreaker.balance = 0; // current balance is already zero — cost 10 -> denied

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "denied");
  assert.equal(result.hardCapReached, true);
});

test("WO-070: a denial where the current balance is still positive (just insufficient for THIS cost) carries hardCapReached: false", async () => {
  const { cacheBreaker, engine } = buildRig();
  cacheBreaker.balance = 5; // positive, just less than the 10-credit cost

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "denied");
  assert.equal(result.hardCapReached, false);
});

test("WO-070: an allowed decision never carries hardCapReached: true", async () => {
  const { cacheBreaker, engine } = buildRig();
  cacheBreaker.balance = 1000;
  cacheBreaker.decrementResult = { outcome: "allowed", balance: 990 };

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "allowed");
  assert.equal(result.hardCapReached, false);
});

test("fallthrough to ledger allow: projected balance lands within 5% of the hard cap, ledger confirms sufficient balance", async () => {
  const { rateMappingService, cacheBreaker, ledgerService, engine } = buildRig();
  rateMappingService.hardCap = 1000; // 5% buffer = 50 — projected balances at or below 50 are the "near the cap" danger zone
  cacheBreaker.balance = 55; // cost 10 -> projected 45, inside the 50-wide buffer zone
  ledgerService.balance = { tenantId: "tenant-a", teamId: "team-1", netBalance: 55, transactionCount: 5, lastTransactionAt: new Date() };

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "allowed");
  assert.equal(result.enforcementMode, "ledger");
  assert.equal(result.balanceAfter, 45); // ledgerService.recordTransaction computes 55 - 10
  assert.equal(ledgerService.recorded.length, 1);
  assert.equal(cacheBreaker.warmed.length, 1, "the cache should be re-warmed with the fresh ledger balance after a fallthrough");
});

test("fallthrough to ledger deny: near the hard cap, but the real ledger balance is insufficient", async () => {
  const { rateMappingService, cacheBreaker, ledgerService, engine } = buildRig();
  rateMappingService.hardCap = 1000;
  cacheBreaker.balance = 55; // near-cap zone (projected 45 <= 50 buffer), triggers the ledger fallthrough
  ledgerService.balance = { tenantId: "tenant-a", teamId: "team-1", netBalance: 5, transactionCount: 5, lastTransactionAt: new Date() }; // real balance is actually much lower than the stale cache suggested — insufficient for the 10-credit cost

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "denied");
  assert.equal(result.enforcementMode, "ledger");
  assert.equal(ledgerService.recorded.length, 0, "a denied fallthrough must never record a debit");
  assert.equal(result.hardCapReached, false, "a still-positive real ledger balance (5) is not yet zero/negative");
});

test("WO-070: fallthrough to ledger deny with a real ledger balance already at zero carries hardCapReached: true", async () => {
  const { rateMappingService, cacheBreaker, ledgerService, engine } = buildRig();
  rateMappingService.hardCap = 1000;
  cacheBreaker.balance = 55;
  ledgerService.balance = { tenantId: "tenant-a", teamId: "team-1", netBalance: 0, transactionCount: 5, lastTransactionAt: new Date() };

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "denied");
  assert.equal(result.hardCapReached, true);
});

test("cache miss: warms the cache from the real ledger balance, then proceeds through the normal decision tree", async () => {
  const { cacheBreaker, ledgerService, engine } = buildRig();
  cacheBreaker.balance = null; // cache miss
  ledgerService.balance = { tenantId: "tenant-a", teamId: "team-1", netBalance: 500, transactionCount: 2, lastTransactionAt: new Date() };
  cacheBreaker.decrementResult = { outcome: "allowed", balance: 490 };

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(cacheBreaker.warmed.length, 1);
  assert.equal(cacheBreaker.warmed[0].balance, 500);
  assert.equal(result.decision, "allowed");
  assert.equal(result.enforcementMode, "cache");
});

test("Redis circuit open: falls through directly to the ledger rather than 'failing open'", async () => {
  const { cacheBreaker, ledgerService, engine } = buildRig();
  cacheBreaker.balance = "circuit_open";
  ledgerService.balance = { tenantId: "tenant-a", teamId: "team-1", netBalance: 1000, transactionCount: 1, lastTransactionAt: new Date() };

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.enforcementMode, "ledger");
  assert.equal(result.decision, "allowed");
  assert.equal(ledgerService.recorded.length, 1, "circuit-open must fall through to a real ledger debit, never a silent allow with no record");
});

test("no rate configured for the action_type: denied without touching cache or ledger", async () => {
  const { rateMappingService, ledgerService, engine } = buildRig();
  rateMappingService.rate = null;

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "denied");
  assert.equal(result.creditsConsumed, 0);
  assert.equal(ledgerService.recorded.length, 0);
});

test("a zero-cost action (e.g. rate rounds to 0) is always allowed without any balance check", async () => {
  const { rateMappingService, ledgerService, engine } = buildRig();
  rateMappingService.rate = 0;

  const result = await engine.checkAndConsume(baseRequest());
  assert.equal(result.decision, "allowed");
  assert.equal(result.creditsConsumed, 0);
  assert.equal(ledgerService.recorded.length, 0);
});

test("with no team_id at all, the hard-cap buffer check is skipped entirely (no team to scope a cap to)", async () => {
  const { cacheBreaker, engine } = buildRig();
  cacheBreaker.balance = 1000;
  cacheBreaker.decrementResult = { outcome: "allowed", balance: 990 };

  const result = await engine.checkAndConsume(baseRequest({ teamId: null }));
  assert.equal(result.enforcementMode, "cache");
  assert.equal(result.decision, "allowed");
});

test("every decision emits a structured JSON log line including tenant_id/team_id/agent_id/decision/enforcement_mode/latency_ms", async () => {
  const originalLog = Logger.prototype.log;
  const captured: string[] = [];
  Logger.prototype.log = function (message: unknown) {
    captured.push(String(message));
  };
  try {
    const { engine } = buildRig();
    await engine.checkAndConsume(baseRequest());
  } finally {
    Logger.prototype.log = originalLog;
  }

  const parsed = captured.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((p) => p?.event === "credit_metering_decision");
  assert.ok(parsed, "expected a structured credit_metering_decision log line");
  assert.equal(parsed.tenant_id, "tenant-a");
  assert.equal(parsed.decision, "allowed");
  assert.ok(typeof parsed.latency_ms === "number");
});
