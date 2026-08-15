import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertSuppressionService } from "../../../src/alerts/suppression/alert-suppression.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

class FakeSnoozeRepository {
  public snoozes = new Map<string, { id: string; tenantId: string; agentId: string; metricName: string; snoozedUntil: Date; createdBy: string | null; createdAt: Date; updatedAt: Date }>();
  private nextId = 1;
  async upsert(_client: unknown, tenantId: string, agentId: string, metricName: string, snoozedUntil: Date, createdBy: string | null) {
    const key = `${tenantId}:${agentId}:${metricName}`;
    const existing = this.snoozes.get(key);
    const record = { id: existing?.id ?? `snooze-${this.nextId++}`, tenantId, agentId, metricName, snoozedUntil, createdBy, createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date() };
    this.snoozes.set(key, record);
    return record;
  }
  async findActive(_client: unknown, tenantId: string, agentId: string, metricName: string, now: Date) {
    const record = this.snoozes.get(`${tenantId}:${agentId}:${metricName}`);
    return record && record.snoozedUntil > now ? record : null;
  }
  async remove(_client: unknown, _tenantId: string, id: string) {
    for (const [key, record] of this.snoozes.entries()) {
      if (record.id === id) {
        this.snoozes.delete(key);
        return record;
      }
    }
    return null;
  }
  async countActiveForTenant(_client: unknown, tenantId: string, now: Date = new Date()) {
    return [...this.snoozes.values()].filter((r) => r.tenantId === tenantId && r.snoozedUntil > now).length;
  }
}

class FakeAutoTuneStateRepository {
  public multiplier = 1;
  public tunedCount = 0;
  async getEffectiveMultiplier() {
    return this.multiplier;
  }
  async countTunedForTenant() {
    return this.tunedCount;
  }
}

class FakeFeedbackRepository {
  public falsePositiveRate = 0;
  public feedbackCount = 0;
  async falsePositiveRateForTenant() {
    return this.falsePositiveRate;
  }
  async countForTenant() {
    return this.feedbackCount;
  }
}

class FakeAuditService {
  public events: unknown[] = [];
  async recordEvent(event: unknown) {
    this.events.push(event);
  }
}

function buildRig() {
  const snoozeRepository = new FakeSnoozeRepository();
  const autoTuneStateRepository = new FakeAutoTuneStateRepository();
  const feedbackRepository = new FakeFeedbackRepository();
  const auditService = new FakeAuditService();
  const service = new AlertSuppressionService(snoozeRepository as any, autoTuneStateRepository as any, feedbackRepository as any, auditService as any);
  return { snoozeRepository, autoTuneStateRepository, feedbackRepository, auditService, service };
}

test("real Redis: creating a snooze makes isAlertSuppressed true for the duration, then false once expired", { skip }, async () => {
  const { service } = buildRig();
  try {
    const now = new Date("2026-08-16T00:00:00Z");
    await service.createSnooze(undefined, "tenant-a", "user-1", "agent-1", "error_rate", "1h", now);

    const duringSnooze = await service.isAlertSuppressed(undefined, "tenant-a", "agent-1", "error_rate", new Date(now.getTime() + 30 * 60 * 1000));
    assert.equal(duringSnooze, true);

    const afterSnooze = await service.isAlertSuppressed(undefined, "tenant-a", "agent-1", "error_rate", new Date(now.getTime() + 2 * 60 * 60 * 1000));
    assert.equal(afterSnooze, false);
  } finally {
    await service.onModuleDestroy();
  }
});

test("real Redis: removeSnooze clears the cache entry so isAlertSuppressed reads through to Postgres (which now also has no record)", { skip }, async () => {
  const { snoozeRepository, service } = buildRig();
  try {
    const now = new Date();
    const snooze = await service.createSnooze(undefined, "tenant-a", "user-1", "agent-1", "error_rate", "24h", now);
    await service.removeSnooze(undefined, "tenant-a", "user-1", snooze.id);

    const suppressed = await service.isAlertSuppressed(undefined, "tenant-a", "agent-1", "error_rate", now);
    assert.equal(suppressed, false);
    assert.equal(snoozeRepository.snoozes.size, 0);
  } finally {
    await service.onModuleDestroy();
  }
});

test("real Redis: createSnooze and removeSnooze both write immutable audit log entries", { skip }, async () => {
  const { auditService, service } = buildRig();
  try {
    const snooze = await service.createSnooze(undefined, "tenant-a", "user-1", "agent-1", "error_rate", "4h");
    await service.removeSnooze(undefined, "tenant-a", "user-1", snooze.id);

    assert.equal(auditService.events.length, 2);
    assert.equal((auditService.events[0] as any).action, "alert.snooze_created");
    assert.equal((auditService.events[1] as any).action, "alert.snooze_removed");
  } finally {
    await service.onModuleDestroy();
  }
});

test("getWarningMultiplier delegates to the auto-tune state repository", { skip }, async () => {
  const { autoTuneStateRepository, service } = buildRig();
  autoTuneStateRepository.multiplier = 1.44;
  try {
    const multiplier = await service.getWarningMultiplier(undefined, "tenant-a", "agent-1", "error_rate");
    assert.equal(multiplier, 1.44);
  } finally {
    await service.onModuleDestroy();
  }
});

test("getSuppressionMetrics aggregates across all three sources", { skip }, async () => {
  const { snoozeRepository, autoTuneStateRepository, feedbackRepository, service } = buildRig();
  feedbackRepository.falsePositiveRate = 0.25;
  feedbackRepository.feedbackCount = 12;
  autoTuneStateRepository.tunedCount = 2;
  await service.createSnooze(undefined, "tenant-a", "user-1", "agent-1", "error_rate", "1h");
  try {
    const metrics = await service.getSuppressionMetrics(undefined, "tenant-a");
    assert.deepEqual(metrics, { falsePositiveRate: 0.25, suppressedCount: 1, feedbackCount: 12, autoTunedCount: 2 });
    void snoozeRepository;
  } finally {
    await service.onModuleDestroy();
  }
});
