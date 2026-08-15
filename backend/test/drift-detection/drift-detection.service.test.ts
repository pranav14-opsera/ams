import { test } from "node:test";
import assert from "node:assert/strict";
import { DriftDetectionService } from "../../src/drift-detection/drift-detection.service";

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: "baseline-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    baselineScore: 85,
    calibrationStartedAt: new Date("2026-08-01T00:00:00Z"),
    establishedAt: new Date("2026-08-08T00:00:00Z") as Date | null,
    ...overrides,
  };
}

function historyRow(compositeScore: number, computedAt: Date, componentOverrides: Record<string, number | null> = {}) {
  return {
    id: `h-${Math.random()}`,
    tenantId: "tenant-a",
    agentId: "agent-1",
    computedAt,
    compositeScore,
    toolCallScore: componentOverrides.toolCallScore ?? compositeScore,
    reasoningScore: componentOverrides.reasoningScore ?? compositeScore,
    consistencyScore: componentOverrides.consistencyScore ?? compositeScore,
    sampleCount: 3,
  };
}

class FakeQualityScoreRepository {
  public baseline: ReturnType<typeof makeBaseline> | null = makeBaseline();
  public baselineHistory: ReturnType<typeof historyRow>[] = Array.from({ length: 20 }, () => historyRow(85, new Date("2026-08-05T00:00:00Z")));
  public recentHistory: ReturnType<typeof historyRow>[] = Array.from({ length: 20 }, () => historyRow(85, new Date()));

  async findBaseline() {
    return this.baseline;
  }
  async getScoreHistoryInRange() {
    return this.baselineHistory;
  }
  async getScoreHistory() {
    return this.recentHistory;
  }
}

class FakeDriftEventRepository {
  public created: unknown[] = [];
  async create(_client: unknown, tenantId: string, agentId: string, fields: Record<string, unknown>) {
    const event = { id: `drift-event-${this.created.length + 1}`, tenantId, agentId, ...fields };
    this.created.push(event);
    return event;
  }
}

class FakeDriftStateRepository {
  public states = new Map<string, { consecutiveDriftCount: number; lastKsStatistic: number | null; lastPValue: number | null }>();
  async find(_client: unknown, tenantId: string, agentId: string) {
    return this.states.get(`${tenantId}:${agentId}`) ?? null;
  }
  async upsert(_client: unknown, tenantId: string, agentId: string, count: number, ks: number, p: number) {
    const state = { consecutiveDriftCount: count, lastKsStatistic: ks, lastPValue: p };
    this.states.set(`${tenantId}:${agentId}`, state);
    return state;
  }
}

class FakeStateCache {
  public cached = new Map<string, { consecutiveDriftCount: number; lastKsStatistic: number; lastPValue: number }>();
  async get(tenantId: string, agentId: string) {
    return this.cached.get(`${tenantId}:${agentId}`) ?? null;
  }
  async set(tenantId: string, agentId: string, state: { consecutiveDriftCount: number; lastKsStatistic: number; lastPValue: number }) {
    this.cached.set(`${tenantId}:${agentId}`, state);
  }
}

class FakeAlertEventRepository {
  public created: unknown[] = [];
  public mostRecent: { breachTimestamp: Date } | null = null;
  async create(_client: unknown, tenantId: string, agentId: string, fields: Record<string, unknown>) {
    const event = { id: `event-${this.created.length + 1}`, tenantId, agentId, ...fields };
    this.created.push(event);
    return event;
  }
  async findMostRecent() {
    return this.mostRecent;
  }
}

class FakeAlertDeliveryService {
  public delivered: unknown[] = [];
  async deliver(event: unknown) {
    this.delivered.push(event);
  }
}

class FakeSuppressionService {
  public suppressed = false;
  async isAlertSuppressed() {
    return this.suppressed;
  }
}

function buildRig() {
  const qualityScoreRepository = new FakeQualityScoreRepository();
  const driftEventRepository = new FakeDriftEventRepository();
  const driftStateRepository = new FakeDriftStateRepository();
  const driftStateCache = new FakeStateCache();
  const alertEventRepository = new FakeAlertEventRepository();
  const alertDeliveryService = new FakeAlertDeliveryService();
  const suppressionService = new FakeSuppressionService();

  const service = new DriftDetectionService(
    qualityScoreRepository as any,
    driftEventRepository as any,
    driftStateRepository as any,
    driftStateCache as any,
    alertEventRepository as any,
    alertDeliveryService as any,
    suppressionService as any,
  );

  return { qualityScoreRepository, driftEventRepository, driftStateRepository, driftStateCache, alertEventRepository, alertDeliveryService, suppressionService, service };
}

test("an agent with no baseline record at all is never evaluated", async () => {
  const { qualityScoreRepository, service } = buildRig();
  qualityScoreRepository.baseline = null;
  const result = await service.evaluateAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result, null);
});

test("an agent still calibrating (baseline not established) is never evaluated", async () => {
  const { qualityScoreRepository, service } = buildRig();
  qualityScoreRepository.baseline = makeBaseline({ establishedAt: null });
  const result = await service.evaluateAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result, null);
});

test("insufficient data on either side (no scored history) is skipped, not fabricated", async () => {
  const { qualityScoreRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = [];
  const result = await service.evaluateAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result, null);
});

test("stable behavior (no real distributional shift) reports no_drift and resets the consecutive counter", async () => {
  const { qualityScoreRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = Array.from({ length: 20 }, (_, i) => historyRow(83 + (i % 4), new Date()));
  qualityScoreRepository.recentHistory = Array.from({ length: 20 }, (_, i) => historyRow(83 + (i % 4), new Date()));

  const result = await service.evaluateAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result?.driftStatus, "no_drift");
  assert.equal(result?.consecutiveWindowCount, 0);
  assert.equal(result?.shouldAlert, false);
});

test("a genuine, statistically significant DEGRADATION increments the consecutive-window counter", async () => {
  const { qualityScoreRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = Array.from({ length: 30 }, (_, i) => historyRow(80 + (i % 11), new Date()));
  qualityScoreRepository.recentHistory = Array.from({ length: 30 }, (_, i) => historyRow(60 + (i % 11), new Date())); // clearly worse

  const result = await service.evaluateAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result?.driftStatus, "drifting");
  assert.equal(result?.consecutiveWindowCount, 1);
  assert.equal(result?.shouldAlert, false); // not yet 3 consecutive windows
});

test("a statistically significant IMPROVEMENT is never flagged as drift (degradation-only filter)", async () => {
  const { qualityScoreRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = Array.from({ length: 30 }, (_, i) => historyRow(60 + (i % 11), new Date()));
  qualityScoreRepository.recentHistory = Array.from({ length: 30 }, (_, i) => historyRow(90 + (i % 8), new Date())); // clearly BETTER, not worse

  const result = await service.evaluateAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result?.driftStatus, "no_drift");
  assert.equal(result?.consecutiveWindowCount, 0);
});

test("3 consecutive drifting windows crosses the threshold, raises exactly one alert with drift evidence, and writes a drift_events row", async () => {
  const { qualityScoreRepository, driftStateCache, driftEventRepository, alertEventRepository, alertDeliveryService, service } = buildRig();
  qualityScoreRepository.baselineHistory = Array.from({ length: 30 }, (_, i) => historyRow(80 + (i % 11), new Date()));
  qualityScoreRepository.recentHistory = Array.from({ length: 30 }, (_, i) => historyRow(60 + (i % 11), new Date()));

  await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T01:00:00Z"));
  await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T02:00:00Z"));
  const third = await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T03:00:00Z"));

  assert.equal(third?.driftStatus, "significant_drift");
  assert.equal(third?.consecutiveWindowCount, 3);
  assert.equal(third?.shouldAlert, true);
  assert.equal(driftEventRepository.created.length, 1);
  assert.equal(alertEventRepository.created.length, 1);
  assert.equal((alertEventRepository.created[0] as any).detectionMethod, "drift");
  assert.equal((alertEventRepository.created[0] as any).statisticalEvidence.algorithmUsed, "ks_test");
  assert.equal(alertDeliveryService.delivered.length, 1);
  void driftStateCache;
});

test("staying drifting past the 3-window crossing point (4th, 5th window) does not re-alert every tick", async () => {
  const { qualityScoreRepository, driftEventRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = Array.from({ length: 30 }, (_, i) => historyRow(80 + (i % 11), new Date()));
  qualityScoreRepository.recentHistory = Array.from({ length: 30 }, (_, i) => historyRow(60 + (i % 11), new Date()));

  for (let hour = 1; hour <= 5; hour++) {
    await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date(`2026-08-16T0${hour}:00:00Z`));
  }
  assert.equal(driftEventRepository.created.length, 1, "only the 3rd (crossing) tick should have raised a drift event, not the 4th/5th");
});

test("an active suppression (snooze) prevents the alert from being raised, even at the 3-window crossing point", async () => {
  const { qualityScoreRepository, suppressionService, alertEventRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = Array.from({ length: 30 }, (_, i) => historyRow(80 + (i % 11), new Date()));
  qualityScoreRepository.recentHistory = Array.from({ length: 30 }, (_, i) => historyRow(60 + (i % 11), new Date()));
  suppressionService.suppressed = true;

  await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T01:00:00Z"));
  await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T02:00:00Z"));
  const third = await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T03:00:00Z"));

  assert.equal(third?.shouldAlert, true, "the evaluation itself still reports the crossing happened");
  assert.equal(alertEventRepository.created.length, 0, "but no alert event should actually be created while suppressed");
});

test("cooldown prevents a second alert for the same agent within the cooldown window", async () => {
  const { qualityScoreRepository, alertEventRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = Array.from({ length: 30 }, (_, i) => historyRow(80 + (i % 11), new Date()));
  qualityScoreRepository.recentHistory = Array.from({ length: 30 }, (_, i) => historyRow(60 + (i % 11), new Date()));
  alertEventRepository.mostRecent = { breachTimestamp: new Date("2026-08-16T02:50:00Z") }; // 10 minutes before the 3rd tick — within a 1hr cooldown

  await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T01:00:00Z"));
  await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T02:00:00Z"));
  await service.evaluateAgent(undefined, "tenant-a", "agent-1", new Date("2026-08-16T03:00:00Z"));

  assert.equal(alertEventRepository.created.length, 0);
});

test("affected components report the delta between baseline and recent averages per component", async () => {
  const { qualityScoreRepository, service } = buildRig();
  qualityScoreRepository.baselineHistory = [historyRow(85, new Date(), { toolCallScore: 90, reasoningScore: 85, consistencyScore: 80 })];
  qualityScoreRepository.recentHistory = [historyRow(85, new Date(), { toolCallScore: 60, reasoningScore: 85, consistencyScore: 80 })]; // only toolCall degraded

  const result = await service.evaluateAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result?.affectedComponents.toolCall, 30);
  assert.equal(result?.affectedComponents.reasoning, 0);
  assert.equal(result?.affectedComponents.consistency, 0);
});
