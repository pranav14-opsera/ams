import { test } from "node:test";
import assert from "node:assert/strict";
import { AnomalyDetectorService } from "../../src/anomaly-detection/anomaly-detector.service";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { id: "config-1", tenantId: "tenant-a", agentId: "agent-1", sensitivity: "medium", enabled: true, ...overrides };
}

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: "baseline-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    metricName: "error_rate",
    ewmaMean: 0.02,
    ewmaVariance: 0.0001,
    baselineMean: 0.02,
    baselineVariance: 0.0001,
    observationCount: 200,
    calibrationStartedAt: new Date("2026-08-01T00:00:00Z"),
    calibrationCompletedAt: new Date("2026-08-08T00:00:00Z"),
    ...overrides,
  };
}

class FakeDriftConfigRepository {
  public configs: ReturnType<typeof makeConfig>[] = [makeConfig()];
  async findAllEnabledForTenant() {
    return this.configs;
  }
}

class FakeBaselineRepository {
  public baselines = new Map<string, ReturnType<typeof makeBaseline>>();
  async findByAgentAndMetric(_client: unknown, _tenantId: string, agentId: string, metricName: string) {
    return this.baselines.get(`${agentId}:${metricName}`) ?? null;
  }
  public ewmaUpdates: unknown[] = [];
  async updateEwmaState(_client: unknown, tenantId: string, agentId: string, metricName: string, mean: number, variance: number, count: number) {
    this.ewmaUpdates.push({ tenantId, agentId, metricName, mean, variance, count });
  }
}

class FakeCalibrationService {
  public latestValues = new Map<string, number | null>();
  async checkAndCompleteCalibration() {
    return false;
  }
  async getLatestMetricValue(_client: unknown, _tenantId: string, agentId: string, metricName: string) {
    return this.latestValues.get(`${agentId}:${metricName}`) ?? null;
  }
}

class FakeEwmaCache {
  public state: Record<string, unknown> | null = null;
  public sets: unknown[] = [];
  async get() {
    return this.state;
  }
  async set(_tenantId: string, _agentId: string, _metricName: string, state: unknown) {
    this.sets.push(state);
  }
}

class FakeEventRepository {
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

function buildRig() {
  const driftConfigRepository = new FakeDriftConfigRepository();
  const baselineRepository = new FakeBaselineRepository();
  const calibrationService = new FakeCalibrationService();
  const ewmaCache = new FakeEwmaCache();
  const eventRepository = new FakeEventRepository();
  const alertDeliveryService = new FakeAlertDeliveryService();

  const detector = new AnomalyDetectorService(
    driftConfigRepository as any,
    baselineRepository as any,
    calibrationService as any,
    ewmaCache as any,
    eventRepository as any,
    alertDeliveryService as any,
  );

  return { driftConfigRepository, baselineRepository, calibrationService, ewmaCache, eventRepository, alertDeliveryService, detector };
}

test("an agent still calibrating (baseline not completed) is never evaluated", async () => {
  const { baselineRepository, calibrationService, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:error_rate", makeBaseline({ calibrationCompletedAt: null }));
  calibrationService.latestValues.set("agent-1:error_rate", 0.5);

  const events = await detector.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("EWMA: a value close to the baseline mean generates no anomaly", async () => {
  const { baselineRepository, calibrationService, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:error_rate", makeBaseline());
  calibrationService.latestValues.set("agent-1:error_rate", 0.021); // essentially at baseline

  const events = await detector.evaluateTenant("tenant-a");
  assert.equal(events.filter((e) => (e as any).metricName === "error_rate").length, 0);
});

test("EWMA: a value many standard deviations from the baseline generates an anomaly with 'ewma' evidence", async () => {
  const { baselineRepository, calibrationService, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:error_rate", makeBaseline({ ewmaMean: 0.02, ewmaVariance: 0.0001 })); // stddev = 0.01
  calibrationService.latestValues.set("agent-1:error_rate", 0.5); // ~48 sigma away

  const events = await detector.evaluateTenant("tenant-a");
  const errorRateEvent = events.find((e) => (e as any).metricName === "error_rate") as any;
  assert.ok(errorRateEvent);
  assert.equal(errorRateEvent.detectionMethod, "anomaly");
  assert.equal(errorRateEvent.statisticalEvidence.algorithmUsed, "ewma");
  assert.equal(errorRateEvent.statisticalEvidence.actualValue, 0.5);
});

test("EWMA state is persisted (Redis + Postgres) after every evaluation, whether or not it's anomalous", async () => {
  const { baselineRepository, calibrationService, ewmaCache, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:error_rate", makeBaseline());
  calibrationService.latestValues.set("agent-1:error_rate", 0.021);

  await detector.evaluateTenant("tenant-a");
  assert.equal(ewmaCache.sets.length, 1);
  assert.equal(baselineRepository.ewmaUpdates.length, 1);
});

test("z-score: token_consumption anomaly detection uses the STATIC baseline (not EWMA)", async () => {
  const { baselineRepository, calibrationService, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:token_consumption", makeBaseline({ metricName: "token_consumption", baselineMean: 500, baselineVariance: 2500 }));
  calibrationService.latestValues.set("agent-1:token_consumption", 5000); // way above 3-sigma

  const events = await detector.evaluateTenant("tenant-a");
  const tokenEvent = events.find((e) => (e as any).metricName === "token_consumption") as any;
  assert.ok(tokenEvent);
  assert.equal(tokenEvent.statisticalEvidence.algorithmUsed, "zscore");
});

test("sensitivity levels change what counts as anomalous for the SAME deviation", async () => {
  const { baselineRepository, calibrationService, driftConfigRepository, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:token_consumption", makeBaseline({ metricName: "token_consumption", baselineMean: 500, baselineVariance: 2500 })); // stddev 50
  calibrationService.latestValues.set("agent-1:token_consumption", 650); // exactly 3 sigma

  driftConfigRepository.configs = [makeConfig({ sensitivity: "low" })]; // 4 sigma threshold
  const lowSensitivityEvents = await detector.evaluateTenant("tenant-a");
  assert.equal(lowSensitivityEvents.filter((e) => (e as any).metricName === "token_consumption").length, 0);

  driftConfigRepository.configs = [makeConfig({ sensitivity: "high" })]; // 2 sigma threshold
  const highSensitivityEvents = await detector.evaluateTenant("tenant-a");
  assert.equal(highSensitivityEvents.filter((e) => (e as any).metricName === "token_consumption").length, 1);
});

test("a disabled drift config is never evaluated (findAllEnabledForTenant excludes it, simulated here by returning no configs)", async () => {
  const { driftConfigRepository, detector } = buildRig();
  driftConfigRepository.configs = [];

  const events = await detector.evaluateTenant("tenant-a");
  assert.equal(events.length, 0);
});

test("cooldown: a recent anomaly for the same agent+metric suppresses a new alert", async () => {
  const { baselineRepository, calibrationService, eventRepository, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:error_rate", makeBaseline());
  calibrationService.latestValues.set("agent-1:error_rate", 0.5);
  eventRepository.mostRecent = { breachTimestamp: new Date(Date.now() - 60_000) }; // 1 minute ago, within the 300s cooldown

  const events = await detector.evaluateTenant("tenant-a");
  assert.equal(events.filter((e) => (e as any).metricName === "error_rate").length, 0);
});

test("a generated anomaly is handed to AlertDeliveryService — same delivery pipeline as threshold alerts (AC)", async () => {
  const { baselineRepository, calibrationService, alertDeliveryService, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:error_rate", makeBaseline());
  calibrationService.latestValues.set("agent-1:error_rate", 0.5);

  const events = await detector.evaluateTenant("tenant-a");
  assert.equal(alertDeliveryService.delivered.length, events.length);
  assert.ok(events.length > 0);
});

test("with no fresh data for a metric, that metric is skipped without error", async () => {
  const { baselineRepository, calibrationService, detector } = buildRig();
  baselineRepository.baselines.set("agent-1:error_rate", makeBaseline());
  calibrationService.latestValues.set("agent-1:error_rate", null as unknown as number);

  const events = await detector.evaluateTenant("tenant-a");
  assert.equal(events.filter((e) => (e as any).metricName === "error_rate").length, 0);
});
