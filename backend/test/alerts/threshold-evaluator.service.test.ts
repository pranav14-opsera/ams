import { test } from "node:test";
import assert from "node:assert/strict";
import { ThresholdEvaluatorService } from "../../src/alerts/threshold-evaluator.service";

function makeThreshold(overrides: Record<string, unknown> = {}) {
  return {
    id: "threshold-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    metricName: "error_rate",
    warningThreshold: 0.03,
    criticalThreshold: 0.05,
    cooldownSeconds: 300,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeHealthRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    tenantId: "tenant-a",
    teamId: null,
    name: "Agent One",
    framework: "langchain",
    lifecycleStatus: "active",
    latencyP50Ms: 100,
    latencyP99Ms: 200,
    errorRateAvg: 0.01,
    tokenConsumptionTotal: 10,
    toolCallSuccessRateAvg: 0.99,
    metricsBucket: new Date(),
    ...overrides,
  };
}

class FakeThresholdRepository {
  public thresholds: ReturnType<typeof makeThreshold>[] = [];
  async findAllForTenant() {
    return this.thresholds;
  }
}

class FakeEventRepository {
  public created: any[] = [];
  public mostRecentByKey = new Map<string, any>();
  async create(_client: unknown, tenantId: string, agentId: string, fields: Record<string, unknown>) {
    const event = { id: `event-${this.created.length + 1}`, tenantId, agentId, ...fields };
    this.created.push(event);
    return event;
  }
  async findMostRecent(_client: unknown, _tenantId: string, agentId: string, metricName: string) {
    return this.mostRecentByKey.get(`${agentId}:${metricName}`) ?? null;
  }
}

class FakeSnapshotCache {
  public snapshots = new Map<string, unknown>();
  async setSnapshot() {
    /* no-op — evaluator populates this itself in the real service; the fake just needs to not throw */
  }
  async getSnapshots(_tenantId: string, agentIds: string[]) {
    const result = new Map();
    for (const id of agentIds) {
      const snap = this.snapshots.get(id);
      if (snap) result.set(id, snap);
    }
    return result;
  }
}

class FakeHealthRepository {
  public rows: ReturnType<typeof makeHealthRow>[] = [makeHealthRow()];
  async withTenantScope(_tenantId: string, fn: (client: undefined) => Promise<unknown>) {
    return fn(undefined);
  }
  async findFleetHealth() {
    return { rows: this.rows, total: this.rows.length };
  }
}

/** WO-060: ThresholdEvaluatorService now hands each generated alert to AlertDeliveryService (which owns dispatching to every configured channel, including websocket) rather than publishing to Redis pub/sub itself. */
class FakeAlertDeliveryService {
  public delivered: unknown[] = [];
  async deliver(alertEvent: unknown) {
    this.delivered.push(alertEvent);
  }
}

/** WO-062: stands in for AlertSuppressionService — the evaluator only ever needs these two reads. */
class FakeSuppressionService {
  public warningMultiplier = 1;
  public suppressed = false;
  async getWarningMultiplier() {
    return this.warningMultiplier;
  }
  async isAlertSuppressed() {
    return this.suppressed;
  }
}

function buildRig() {
  const thresholdRepository = new FakeThresholdRepository();
  const eventRepository = new FakeEventRepository();
  const snapshotCache = new FakeSnapshotCache();
  const healthRepository = new FakeHealthRepository();
  const alertDeliveryService = new FakeAlertDeliveryService();
  const suppressionService = new FakeSuppressionService();
  const evaluator = new ThresholdEvaluatorService(thresholdRepository as any, eventRepository as any, snapshotCache as any, healthRepository as any, alertDeliveryService as any, suppressionService as any);
  return { thresholdRepository, eventRepository, snapshotCache, healthRepository, alertDeliveryService, suppressionService, evaluator };
}

test("WO-062: no suppressionService wired at all behaves exactly as before (no suppression, no auto-tuning)", async () => {
  const thresholdRepository = new FakeThresholdRepository();
  const eventRepository = new FakeEventRepository();
  const snapshotCache = new FakeSnapshotCache();
  const healthRepository = new FakeHealthRepository();
  const alertDeliveryService = new FakeAlertDeliveryService();
  const evaluator = new ThresholdEvaluatorService(thresholdRepository as any, eventRepository as any, snapshotCache as any, healthRepository as any, alertDeliveryService as any);
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.04 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.04 });

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 1);
});

test("WO-062: an active snooze suppresses a warning-severity breach", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, suppressionService, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.04 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.04 });
  suppressionService.suppressed = true;

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("WO-062: an active snooze ALSO suppresses a critical-severity breach — manual snooze is an explicit user action, unlike auto-tuning", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, suppressionService, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });
  suppressionService.suppressed = true;

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("WO-062: auto-tune's warning multiplier raises the effective warning threshold", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, suppressionService, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold({ warningThreshold: 0.03, criticalThreshold: 0.05 })];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.04 })]; // originally a warning breach (> 0.03)
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.04 });
  suppressionService.warningMultiplier = 2; // effective warning threshold is now 0.06 — 0.04 no longer breaches it

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0, "a value that only breached the ORIGINAL warning threshold should no longer alert once auto-tuned");
});

test("WO-062: auto-tune's warning multiplier NEVER widens the critical threshold — a genuine critical breach always still fires", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, suppressionService, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold({ warningThreshold: 0.03, criticalThreshold: 0.05 })];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });
  suppressionService.warningMultiplier = 2; // even at the 2x cap, criticalThreshold (0.05) is untouched — 0.9 is still far above it

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "critical");
  assert.equal(events[0].thresholdValue, 0.05);
});

test("WO-062: the tuned warning threshold value is recorded on the alert event itself", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, suppressionService, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold({ warningThreshold: 0.03, criticalThreshold: 0.05 })];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.048 })]; // above tuned warning (0.045) but below critical (0.05)
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.048 });
  suppressionService.warningMultiplier = 1.5;

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "warning");
  assert.equal(events[0].thresholdValue, 0.045);
});

test("a value below warning generates no alert", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.01 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.01 });

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("a value between warning and critical generates a 'warning' severity alert", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.04 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.04 });

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "warning");
  assert.equal(events[0].thresholdValue, 0.03);
});

test("a value above critical generates a 'critical' severity alert", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "critical");
  assert.equal(events[0].thresholdValue, 0.05);
});

test("cooldown enforcement: a breach within the cooldown window since the last alert is skipped", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, eventRepository, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold({ cooldownSeconds: 300 })];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });
  const now = new Date("2026-08-16T00:10:00Z");
  eventRepository.mostRecentByKey.set("agent-1:error_rate", { breachTimestamp: new Date("2026-08-16T00:08:00Z") }); // 2 minutes ago, within a 5-minute cooldown

  const events = await evaluator.evaluateTenant("tenant-a", now);
  assert.equal(events.length, 0);
});

test("cooldown expired: a breach after the cooldown window has elapsed DOES generate a new alert", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, eventRepository, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold({ cooldownSeconds: 300 })];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });
  const now = new Date("2026-08-16T00:10:00Z");
  eventRepository.mostRecentByKey.set("agent-1:error_rate", { breachTimestamp: new Date("2026-08-16T00:00:00Z") }); // 10 minutes ago, past the 5-minute cooldown

  const events = await evaluator.evaluateTenant("tenant-a", now);
  assert.equal(events.length, 1);
});

test("an agent with no recorded metrics yet is skipped, not fabricated as a breach", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ metricsBucket: null, errorRateAvg: null })];
  snapshotCache.snapshots.clear();

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("a paused agent is skipped entirely, even with a breaching last-known value", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ lifecycleStatus: "paused", errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("a retired agent is skipped entirely", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ lifecycleStatus: "retired", errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("a threshold configured for a metric with no cached snapshot value (e.g. resource_utilization) is silently skipped", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold({ metricName: "resource_utilization", warningThreshold: 0.8, criticalThreshold: 0.9 })];
  healthRepository.rows = [makeHealthRow()];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.01 }); // no resource_utilization key at all

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("a generated alert is handed to AlertDeliveryService for multi-channel dispatch", async () => {
  const { thresholdRepository, healthRepository, snapshotCache, alertDeliveryService, evaluator } = buildRig();
  thresholdRepository.thresholds = [makeThreshold()];
  healthRepository.rows = [makeHealthRow({ errorRateAvg: 0.9 })];
  snapshotCache.snapshots.set("agent-1", { error_rate: 0.9 });

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(alertDeliveryService.delivered.length, 1);
  assert.equal((alertDeliveryService.delivered[0] as any).id, events[0].id);
});

test("with zero thresholds configured for the tenant, the evaluator does no work at all (no health query, no events)", async () => {
  const { thresholdRepository, healthRepository, evaluator } = buildRig();
  thresholdRepository.thresholds = [];
  let queried = false;
  healthRepository.findFleetHealth = async () => {
    queried = true;
    return { rows: [], total: 0 };
  };

  const events = await evaluator.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
  assert.equal(queried, false);
});
