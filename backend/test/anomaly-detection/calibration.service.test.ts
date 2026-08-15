import { test } from "node:test";
import assert from "node:assert/strict";
import { CalibrationService } from "../../src/anomaly-detection/calibration.service";
import { CALIBRATION_PERIOD_DAYS } from "../../src/anomaly-detection/anomaly-detection.types";

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: "baseline-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    metricName: "error_rate",
    ewmaMean: null,
    ewmaVariance: null,
    baselineMean: null,
    baselineVariance: null,
    observationCount: 0,
    calibrationStartedAt: new Date("2026-08-01T00:00:00Z"),
    calibrationCompletedAt: null,
    ...overrides,
  };
}

class FakePool {
  public queries: Array<{ text: string; params: unknown[] }> = [];
  public queryResult: { rows: unknown[] } = { rows: [] };
  public released = 0;
  async query(text: string, params: unknown[] = []) {
    this.queries.push({ text, params });
    return this.queryResult;
  }
  // withTenantScope acquires a dedicated client (mirroring HealthDashboardRepository.withTenantScope) when no client is passed in — the fake just proxies back to the same query log/result so existing assertions on `pool.queries`/`pool.queryResult` still work.
  async connect() {
    return {
      query: (text: string, params: unknown[] = []) => this.query(text, params),
      release: () => {
        this.released += 1;
      },
    };
  }
}

class FakeBaselineRepository {
  public baseline: ReturnType<typeof makeBaseline> | null = makeBaseline();
  public completed: unknown[] = [];
  async findByAgentAndMetric() {
    return this.baseline;
  }
  async completeCalibration(_client: unknown, tenantId: string, agentId: string, metricName: string, mean: number, variance: number, count: number) {
    const completed = { tenantId, agentId, metricName, mean, variance, count };
    this.completed.push(completed);
    return completed;
  }
  async ensureStarted() {
    return makeBaseline();
  }
}

function buildRig() {
  const pool = new FakePool();
  const baselineRepository = new FakeBaselineRepository();
  const service = new CalibrationService(pool as any, baselineRepository as any);
  return { pool, baselineRepository, service };
}

test("getCalibrationStatus: completed calibration is never 'calibrating'", () => {
  const { service } = buildRig();
  const status = service.getCalibrationStatus(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-08T00:00:00Z"), new Date("2026-08-16T00:00:00Z"));
  assert.equal(status.calibrating, false);
  assert.equal(status.daysRemaining, 0);
});

test("getCalibrationStatus: mid-window reports the correct days remaining", () => {
  const { service } = buildRig();
  const startedAt = new Date("2026-08-10T00:00:00Z");
  const now = new Date("2026-08-13T00:00:00Z"); // 3 days elapsed of a 7-day window
  const status = service.getCalibrationStatus(startedAt, null, now);
  assert.equal(status.calibrating, true);
  assert.equal(status.daysRemaining, 4);
});

test("getCalibrationStatus: exactly at the 7-day mark is no longer calibrating", () => {
  const { service } = buildRig();
  const startedAt = new Date("2026-08-01T00:00:00Z");
  const now = new Date(startedAt.getTime() + CALIBRATION_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const status = service.getCalibrationStatus(startedAt, null, now);
  assert.equal(status.calibrating, false);
  assert.equal(status.daysRemaining, 0);
});

test("checkAndCompleteCalibration: still within the 7-day window does nothing", async () => {
  const { baselineRepository, service } = buildRig();
  baselineRepository.baseline = makeBaseline({ calibrationStartedAt: new Date("2026-08-14T00:00:00Z") });

  const completed = await service.checkAndCompleteCalibration(undefined, "tenant-a", "agent-1", "error_rate", new Date("2026-08-16T00:00:00Z"));
  assert.equal(completed, false);
  assert.equal(baselineRepository.completed.length, 0);
});

test("checkAndCompleteCalibration: already completed is a no-op", async () => {
  const { baselineRepository, service } = buildRig();
  baselineRepository.baseline = makeBaseline({ calibrationCompletedAt: new Date("2026-08-08T00:00:00Z") });

  const completed = await service.checkAndCompleteCalibration(undefined, "tenant-a", "agent-1", "error_rate", new Date("2026-08-16T00:00:00Z"));
  assert.equal(completed, false);
});

test("checkAndCompleteCalibration: window elapsed but not enough historical buckets defers completion", async () => {
  const { pool, baselineRepository, service } = buildRig();
  baselineRepository.baseline = makeBaseline({ calibrationStartedAt: new Date("2026-08-01T00:00:00Z") });
  pool.queryResult = { rows: [{ mean: "0.02", variance: "0.0001", sample_count: "3" }] }; // far below MIN_BUCKETS_FOR_CALIBRATION

  const completed = await service.checkAndCompleteCalibration(undefined, "tenant-a", "agent-1", "error_rate", new Date("2026-08-16T00:00:00Z"));
  assert.equal(completed, false);
  assert.equal(baselineRepository.completed.length, 0);
});

test("checkAndCompleteCalibration: window elapsed with sufficient data completes calibration with the real computed mean/variance", async () => {
  const { pool, baselineRepository, service } = buildRig();
  baselineRepository.baseline = makeBaseline({ calibrationStartedAt: new Date("2026-08-01T00:00:00Z") });
  pool.queryResult = { rows: [{ mean: "0.021", variance: "0.00015", sample_count: "150" }] };

  const completed = await service.checkAndCompleteCalibration(undefined, "tenant-a", "agent-1", "error_rate", new Date("2026-08-16T00:00:00Z"));
  assert.equal(completed, true);
  assert.equal(baselineRepository.completed.length, 1);
  const recorded = baselineRepository.completed[0] as { mean: number; variance: number; count: number };
  assert.equal(recorded.mean, 0.021);
  assert.equal(recorded.variance, 0.00015);
  assert.equal(recorded.count, 150);
});

test("checkAndCompleteCalibration: no baseline record at all is a no-op", async () => {
  const { baselineRepository, service } = buildRig();
  baselineRepository.baseline = null;

  const completed = await service.checkAndCompleteCalibration(undefined, "tenant-a", "agent-1", "error_rate");
  assert.equal(completed, false);
});

test("getLatestMetricValue returns the queried value, converted to a number", async () => {
  const { pool, service } = buildRig();
  pool.queryResult = { rows: [{ value: "1234.5" }] };

  const value = await service.getLatestMetricValue(undefined, "tenant-a", "agent-1", "latency_p99");
  assert.equal(value, 1234.5);
});

test("getLatestMetricValue returns null when there's no recent bucket at all", async () => {
  const { pool, service } = buildRig();
  pool.queryResult = { rows: [] };

  const value = await service.getLatestMetricValue(undefined, "tenant-a", "agent-1", "latency_p99");
  assert.equal(value, null);
});
