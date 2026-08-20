import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditReconciliationService } from "../../../src/credits/reconciliation/credit-reconciliation.service";
import type { CreditConsumptionEvent } from "../../../src/credits/credit-consumption-kafka-producer.service";

function makeEvent(overrides: Partial<CreditConsumptionEvent> = {}): CreditConsumptionEvent {
  return {
    eventId: `event-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: "tenant-a",
    teamId: "team-1",
    agentId: null,
    actionType: "tool_call",
    creditsConsumed: 10,
    enforcementMode: "cache",
    decision: "allowed",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeProcessedEventRepository {
  public processed = new Set<string>();
  async isProcessed(_client: unknown, eventId: string) {
    return this.processed.has(eventId);
  }
  async markProcessed(_client: unknown, eventId: string) {
    this.processed.add(eventId);
  }
}

class FakeLedgerService {
  public recorded: unknown[] = [];
  public shouldFailFor: Set<string> = new Set();
  public balance = 990;
  public refreshCount = 0;
  async recordTransaction(_client: unknown, tenantId: string, request: Record<string, unknown>) {
    if (this.shouldFailFor.has(tenantId)) throw new Error("simulated ledger failure");
    const transaction = { id: `txn-${this.recorded.length + 1}`, tenantId, ...request };
    this.recorded.push(transaction);
    return transaction;
  }
  async refreshBalances() {
    this.refreshCount++;
  }
  async getBalance(_client: unknown, tenantId: string, teamId: string | null) {
    return { tenantId, teamId, netBalance: this.balance, transactionCount: 1, lastTransactionAt: new Date() };
  }
}

class FakeCacheBreaker {
  public warmed: Array<{ tenantId: string; teamId: string | null; balance: number }> = [];
  async warmCache(tenantId: string, teamId: string | null, balance: number) {
    this.warmed.push({ tenantId, teamId, balance });
  }
}

class FakeDlqProducer {
  public published: unknown[] = [];
  async publish(entry: unknown) {
    this.published.push(entry);
  }
}

class FakeAlertEventRepository {
  public created: unknown[] = [];
  async create(_client: unknown, tenantId: string, agentId: string, fields: Record<string, unknown>) {
    const event = { id: `alert-${this.created.length + 1}`, tenantId, agentId, ...fields };
    this.created.push(event);
    return event;
  }
}

class FakeAlertDeliveryService {
  public delivered: unknown[] = [];
  async deliver(event: unknown) {
    this.delivered.push(event);
  }
}

class FakeThresholdMonitorService {
  public calls: Array<{ tenantId: string; teamIds: string[] }> = [];
  async evaluateThresholds(_client: unknown, tenantId: string, teamIds: string[]) {
    this.calls.push({ tenantId, teamIds });
    return [];
  }
}

class FakeHardCapEnforcementService {
  public calls: Array<{ tenantId: string; teamId: string }> = [];
  async enforceIfBreached(_client: unknown, tenantId: string, teamId: string) {
    this.calls.push({ tenantId, teamId });
    return { pausedAgentIds: [], resumedAgentIds: [] };
  }
}

function buildRig() {
  const processedEventRepository = new FakeProcessedEventRepository();
  const ledgerService = new FakeLedgerService();
  const cacheBreaker = new FakeCacheBreaker();
  const dlqProducer = new FakeDlqProducer();
  const alertEventRepository = new FakeAlertEventRepository();
  const alertDeliveryService = new FakeAlertDeliveryService();
  const thresholdMonitorService = new FakeThresholdMonitorService();
  const hardCapEnforcementService = new FakeHardCapEnforcementService();
  const service = new CreditReconciliationService(
    processedEventRepository as any,
    ledgerService as any,
    cacheBreaker as any,
    dlqProducer as any,
    alertEventRepository as any,
    alertDeliveryService as any,
    thresholdMonitorService as any,
    hardCapEnforcementService as any,
  );
  return { processedEventRepository, ledgerService, cacheBreaker, dlqProducer, alertEventRepository, alertDeliveryService, thresholdMonitorService, hardCapEnforcementService, service };
}

test("a genuine cache-mode allowed event is recorded as a real ledger debit and marked processed", async () => {
  const { ledgerService, processedEventRepository, service } = buildRig();
  const event = makeEvent();

  const result = await service.processBatch(undefined, [event]);
  assert.equal(result.processed, 1);
  assert.equal(ledgerService.recorded.length, 1);
  assert.ok(processedEventRepository.processed.has(event.eventId));
});

test("a duplicate event (already marked processed) is deduplicated, not re-debited", async () => {
  const { processedEventRepository, ledgerService, service } = buildRig();
  const event = makeEvent();
  processedEventRepository.processed.add(event.eventId);

  const result = await service.processBatch(undefined, [event]);
  assert.equal(result.deduplicated, 1);
  assert.equal(result.processed, 0);
  assert.equal(ledgerService.recorded.length, 0);
});

test("a 'denied' event is skipped — nothing was consumed, so there is nothing to reconcile", async () => {
  const { ledgerService, service } = buildRig();
  const event = makeEvent({ decision: "denied" });

  const result = await service.processBatch(undefined, [event]);
  assert.equal(result.skipped, 1);
  assert.equal(ledgerService.recorded.length, 0);
});

test("a 'ledger'-mode event is skipped — its debit was already recorded synchronously at decision time, reconciling it again would double-debit", async () => {
  const { ledgerService, service } = buildRig();
  const event = makeEvent({ enforcementMode: "ledger" });

  const result = await service.processBatch(undefined, [event]);
  assert.equal(result.skipped, 1);
  assert.equal(ledgerService.recorded.length, 0);
});

test("a zero-cost event is skipped — no debit is ever meaningful for a free action", async () => {
  const { ledgerService, service } = buildRig();
  const event = makeEvent({ creditsConsumed: 0 });

  const result = await service.processBatch(undefined, [event]);
  assert.equal(result.skipped, 1);
  assert.equal(ledgerService.recorded.length, 0);
});

test("a failing event is routed to the DLQ with error details, and does not stop the rest of the batch from processing", async () => {
  const { ledgerService, dlqProducer, service } = buildRig();
  ledgerService.shouldFailFor.add("tenant-broken");
  const goodEvent = makeEvent({ tenantId: "tenant-a" });
  const badEvent = makeEvent({ tenantId: "tenant-broken" });

  const result = await service.processBatch(undefined, [badEvent, goodEvent]);
  assert.equal(result.processed, 1, "the good event in the same batch should still be processed");
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].event.tenantId, "tenant-broken");
  assert.ok(result.failed[0].error.includes("simulated ledger failure"));
  assert.equal(dlqProducer.published.length, 1);
});

test("a DLQ-routed event with a real agent_id raises a real alert through the shared alert-delivery pipeline", async () => {
  const { ledgerService, alertEventRepository, alertDeliveryService, service } = buildRig();
  ledgerService.shouldFailFor.add("tenant-broken");
  const badEvent = makeEvent({ tenantId: "tenant-broken", agentId: "11111111-1111-1111-1111-111111111111" });

  await service.processBatch(undefined, [badEvent]);
  assert.equal(alertEventRepository.created.length, 1);
  assert.equal((alertEventRepository.created[0] as any).metricName, "credit_reconciliation_dlq");
  assert.equal(alertDeliveryService.delivered.length, 1);
});

test("a DLQ-routed event with no agent_id at all skips alert_events emission (that table requires a real agent) without throwing", async () => {
  const { ledgerService, alertEventRepository, service } = buildRig();
  ledgerService.shouldFailFor.add("tenant-broken");
  const badEvent = makeEvent({ tenantId: "tenant-broken", agentId: null });

  const result = await service.processBatch(undefined, [badEvent]);
  assert.equal(result.failed.length, 1, "the event is still correctly DLQ'd");
  assert.equal(alertEventRepository.created.length, 0);
});

test("without the optional alert services wired at all, DLQ routing still works exactly as before (zero blast radius)", async () => {
  const processedEventRepository = new FakeProcessedEventRepository();
  const ledgerService = new FakeLedgerService();
  const cacheBreaker = new FakeCacheBreaker();
  const dlqProducer = new FakeDlqProducer();
  ledgerService.shouldFailFor.add("tenant-broken");
  const service = new CreditReconciliationService(processedEventRepository as any, ledgerService as any, cacheBreaker as any, dlqProducer as any);

  const result = await service.processBatch(undefined, [makeEvent({ tenantId: "tenant-broken" })]);
  assert.equal(result.failed.length, 1);
  assert.equal(dlqProducer.published.length, 1);
});

test("after processing a batch with at least one real debit, balances are refreshed and the affected team's cache is re-warmed", async () => {
  const { ledgerService, cacheBreaker, service } = buildRig();
  const event = makeEvent({ tenantId: "tenant-a", teamId: "team-1" });

  await service.processBatch(undefined, [event]);
  assert.equal(ledgerService.refreshCount, 1);
  assert.equal(cacheBreaker.warmed.length, 1);
  assert.equal(cacheBreaker.warmed[0].tenantId, "tenant-a");
  assert.equal(cacheBreaker.warmed[0].teamId, "team-1");
});

test("a batch where every event is skipped/deduplicated never triggers a refresh or cache re-warm", async () => {
  const { ledgerService, cacheBreaker, service } = buildRig();
  const event = makeEvent({ decision: "denied" });

  await service.processBatch(undefined, [event]);
  assert.equal(ledgerService.refreshCount, 0);
  assert.equal(cacheBreaker.warmed.length, 0);
});

test("multiple events for the same (tenant, team) only re-warm the cache once per affected key, not once per event", async () => {
  const { cacheBreaker, service } = buildRig();
  const events = [makeEvent({ tenantId: "tenant-a", teamId: "team-1" }), makeEvent({ tenantId: "tenant-a", teamId: "team-1" }), makeEvent({ tenantId: "tenant-a", teamId: "team-1" })];

  await service.processBatch(undefined, events);
  assert.equal(cacheBreaker.warmed.length, 1);
});

test("getLastSuccessfulBatchAt reflects only genuinely successful (processed > 0) batches", async () => {
  const { service } = buildRig();
  assert.equal(service.getLastSuccessfulBatchAt(), null);

  await service.processBatch(undefined, [makeEvent({ decision: "denied" })]);
  assert.equal(service.getLastSuccessfulBatchAt(), null, "an all-skipped batch is not a 'successful' reconciliation");

  await service.processBatch(undefined, [makeEvent()]);
  assert.ok(service.getLastSuccessfulBatchAt() instanceof Date);
});

test("WO-069: a successful batch triggers threshold monitoring for every affected (tenant, team), grouped by tenant", async () => {
  const { thresholdMonitorService, service } = buildRig();
  const events = [makeEvent({ tenantId: "tenant-a", teamId: "team-1" }), makeEvent({ tenantId: "tenant-a", teamId: "team-2" }), makeEvent({ tenantId: "tenant-b", teamId: "team-3" })];

  await service.processBatch(undefined, events);

  assert.equal(thresholdMonitorService.calls.length, 2, "one call per distinct tenant, not once per event");
  const tenantACall = thresholdMonitorService.calls.find((c) => c.tenantId === "tenant-a")!;
  assert.deepEqual(tenantACall.teamIds.sort(), ["team-1", "team-2"]);
  const tenantBCall = thresholdMonitorService.calls.find((c) => c.tenantId === "tenant-b")!;
  assert.deepEqual(tenantBCall.teamIds, ["team-3"]);
});

test("WO-069: a batch where nothing was genuinely reconciled (all skipped/deduplicated) never triggers threshold monitoring", async () => {
  const { thresholdMonitorService, service } = buildRig();
  await service.processBatch(undefined, [makeEvent({ decision: "denied" })]);
  assert.equal(thresholdMonitorService.calls.length, 0);
});

test("WO-069: without the optional ThresholdMonitorService wired at all, batch processing still works exactly as before (zero blast radius)", async () => {
  const processedEventRepository = new FakeProcessedEventRepository();
  const ledgerService = new FakeLedgerService();
  const cacheBreaker = new FakeCacheBreaker();
  const dlqProducer = new FakeDlqProducer();
  const service = new CreditReconciliationService(processedEventRepository as any, ledgerService as any, cacheBreaker as any, dlqProducer as any);

  const result = await service.processBatch(undefined, [makeEvent()]);
  assert.equal(result.processed, 1);
});

test("WO-070: a successful batch triggers hard-cap enforcement for every affected (tenant, team) with a real team_id", async () => {
  const { hardCapEnforcementService, service } = buildRig();
  const events = [makeEvent({ tenantId: "tenant-a", teamId: "team-1" }), makeEvent({ tenantId: "tenant-a", teamId: "team-2" }), makeEvent({ tenantId: "tenant-b", teamId: "team-3" })];

  await service.processBatch(undefined, events);

  assert.equal(hardCapEnforcementService.calls.length, 3, "one call per distinct (tenant, team) pair");
  assert.ok(hardCapEnforcementService.calls.some((c) => c.tenantId === "tenant-a" && c.teamId === "team-1"));
  assert.ok(hardCapEnforcementService.calls.some((c) => c.tenantId === "tenant-a" && c.teamId === "team-2"));
  assert.ok(hardCapEnforcementService.calls.some((c) => c.tenantId === "tenant-b" && c.teamId === "team-3"));
});

test("WO-070: a batch where nothing was genuinely reconciled never triggers hard-cap enforcement", async () => {
  const { hardCapEnforcementService, service } = buildRig();
  await service.processBatch(undefined, [makeEvent({ decision: "denied" })]);
  assert.equal(hardCapEnforcementService.calls.length, 0);
});

test("WO-070: a failure in hard-cap enforcement for one team never stops threshold monitoring or the rest of the batch's outcome", async () => {
  const { hardCapEnforcementService, thresholdMonitorService, service } = buildRig();
  hardCapEnforcementService.enforceIfBreached = async () => {
    throw new Error("simulated hard-cap enforcement failure");
  };

  const result = await service.processBatch(undefined, [makeEvent({ tenantId: "tenant-a", teamId: "team-1" })]);
  assert.equal(result.processed, 1);
  assert.equal(thresholdMonitorService.calls.length, 1, "threshold monitoring must still run even if hard-cap enforcement throws");
});

test("WO-070: without the optional HardCapEnforcementService wired at all, batch processing still works exactly as before (zero blast radius)", async () => {
  const processedEventRepository = new FakeProcessedEventRepository();
  const ledgerService = new FakeLedgerService();
  const cacheBreaker = new FakeCacheBreaker();
  const dlqProducer = new FakeDlqProducer();
  const service = new CreditReconciliationService(processedEventRepository as any, ledgerService as any, cacheBreaker as any, dlqProducer as any);

  const result = await service.processBatch(undefined, [makeEvent()]);
  assert.equal(result.processed, 1);
});
