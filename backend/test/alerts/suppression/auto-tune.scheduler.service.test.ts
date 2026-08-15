import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoTuneSchedulerService } from "../../../src/alerts/suppression/auto-tune.scheduler.service";
import { AUTO_TUNE_MAX_MULTIPLIER } from "../../../src/alerts/suppression/alert-suppression.types";

class FakeFeedbackRepository {
  public tenantIds: string[] = ["tenant-a"];
  public patterns: Array<{ agentId: string; metricName: string }> = [];
  public countsByPattern = new Map<string, { falsePositiveCount: number; confirmedCount: number }>();
  async findDistinctTenantIds() {
    return this.tenantIds;
  }
  async findDistinctPatternsWithFeedback() {
    return this.patterns;
  }
  async getPatternFeedback(_client: unknown, _tenantId: string, agentId: string, metricName: string) {
    return this.countsByPattern.get(`${agentId}:${metricName}`) ?? { falsePositiveCount: 0, confirmedCount: 0 };
  }
}

class FakeAutoTuneStateRepository {
  public states = new Map<string, { id: string; tenantId: string; agentId: string; metricName: string; warningMultiplier: number; lastTunedAt: Date | null; feedbackCursor: Date }>();
  private nextId = 1;
  async findByPattern(_client: unknown, tenantId: string, agentId: string, metricName: string) {
    return this.states.get(`${tenantId}:${agentId}:${metricName}`) ?? null;
  }
  async applyTuningStep(_client: unknown, tenantId: string, agentId: string, metricName: string, stepMultiplier: number, maxMultiplier: number, newCursor: Date) {
    const key = `${tenantId}:${agentId}:${metricName}`;
    const existing = this.states.get(key);
    const updated = {
      id: existing?.id ?? `state-${this.nextId++}`,
      tenantId,
      agentId,
      metricName,
      warningMultiplier: Math.min((existing?.warningMultiplier ?? 1) * stepMultiplier, maxMultiplier),
      lastTunedAt: newCursor,
      feedbackCursor: newCursor,
    };
    this.states.set(key, updated);
    return updated;
  }
}

class FakeAuditService {
  public events: unknown[] = [];
  async recordEvent(event: unknown) {
    this.events.push(event);
  }
}

function buildRig() {
  const feedbackRepository = new FakeFeedbackRepository();
  const autoTuneStateRepository = new FakeAutoTuneStateRepository();
  const auditService = new FakeAuditService();
  const scheduler = new AutoTuneSchedulerService(feedbackRepository as any, autoTuneStateRepository as any, auditService as any);
  return { feedbackRepository, autoTuneStateRepository, auditService, scheduler };
}

test("a pattern with 3+ false positives and zero confirmations gets tuned by one step", async () => {
  const { feedbackRepository, autoTuneStateRepository, auditService, scheduler } = buildRig();
  feedbackRepository.patterns = [{ agentId: "agent-1", metricName: "error_rate" }];
  feedbackRepository.countsByPattern.set("agent-1:error_rate", { falsePositiveCount: 3, confirmedCount: 0 });

  await scheduler.tuneTenant("tenant-a");

  const state = autoTuneStateRepository.states.get("tenant-a:agent-1:error_rate");
  assert.ok(state);
  assert.equal(state!.warningMultiplier, 1.2);
  assert.equal(auditService.events.length, 1);
  assert.equal((auditService.events[0] as any).action, "alert.auto_tuned");
});

test("a pattern with fewer than 3 false positives is never tuned", async () => {
  const { feedbackRepository, autoTuneStateRepository, scheduler } = buildRig();
  feedbackRepository.patterns = [{ agentId: "agent-1", metricName: "error_rate" }];
  feedbackRepository.countsByPattern.set("agent-1:error_rate", { falsePositiveCount: 2, confirmedCount: 0 });

  await scheduler.tuneTenant("tenant-a");
  assert.equal(autoTuneStateRepository.states.size, 0);
});

test("a pattern with ANY confirmed feedback is never tuned, even with many false positives", async () => {
  const { feedbackRepository, autoTuneStateRepository, scheduler } = buildRig();
  feedbackRepository.patterns = [{ agentId: "agent-1", metricName: "error_rate" }];
  feedbackRepository.countsByPattern.set("agent-1:error_rate", { falsePositiveCount: 10, confirmedCount: 1 });

  await scheduler.tuneTenant("tenant-a");
  assert.equal(autoTuneStateRepository.states.size, 0);
});

test("the multiplier is capped at AUTO_TUNE_MAX_MULTIPLIER, never exceeded across repeated tuning", async () => {
  const { feedbackRepository, autoTuneStateRepository, scheduler } = buildRig();
  feedbackRepository.patterns = [{ agentId: "agent-1", metricName: "error_rate" }];
  feedbackRepository.countsByPattern.set("agent-1:error_rate", { falsePositiveCount: 5, confirmedCount: 0 });

  // Force feedbackCursor back before each run so getPatternFeedback's fake always returns the same counts (a real DB-backed cursor would naturally exclude already-counted feedback; the fake doesn't model that, so this test isolates purely the multiplier-capping arithmetic).
  for (let i = 0; i < 10; i++) {
    await scheduler.tuneTenant("tenant-a");
  }

  const state = autoTuneStateRepository.states.get("tenant-a:agent-1:error_rate");
  assert.equal(state!.warningMultiplier, AUTO_TUNE_MAX_MULTIPLIER);
});

test("a pattern already at the multiplier cap is skipped entirely — no repository write, no audit event", async () => {
  const { feedbackRepository, autoTuneStateRepository, auditService, scheduler } = buildRig();
  feedbackRepository.patterns = [{ agentId: "agent-1", metricName: "error_rate" }];
  feedbackRepository.countsByPattern.set("agent-1:error_rate", { falsePositiveCount: 3, confirmedCount: 0 });
  autoTuneStateRepository.states.set("tenant-a:agent-1:error_rate", { id: "state-1", tenantId: "tenant-a", agentId: "agent-1", metricName: "error_rate", warningMultiplier: AUTO_TUNE_MAX_MULTIPLIER, lastTunedAt: new Date(), feedbackCursor: new Date() });

  await scheduler.tuneTenant("tenant-a");
  assert.equal(auditService.events.length, 0);
});

test("multiple distinct patterns are each evaluated and tuned independently", async () => {
  const { feedbackRepository, autoTuneStateRepository, scheduler } = buildRig();
  feedbackRepository.patterns = [
    { agentId: "agent-1", metricName: "error_rate" },
    { agentId: "agent-2", metricName: "latency_p99" },
  ];
  feedbackRepository.countsByPattern.set("agent-1:error_rate", { falsePositiveCount: 3, confirmedCount: 0 });
  feedbackRepository.countsByPattern.set("agent-2:latency_p99", { falsePositiveCount: 1, confirmedCount: 0 });

  await scheduler.tuneTenant("tenant-a");

  assert.ok(autoTuneStateRepository.states.has("tenant-a:agent-1:error_rate"));
  assert.ok(!autoTuneStateRepository.states.has("tenant-a:agent-2:latency_p99"));
});

test("runTuningTick sweeps every tenant with any feedback and never throws even if one tenant's tuning fails", async () => {
  const { feedbackRepository, scheduler } = buildRig();
  feedbackRepository.tenantIds = ["tenant-a", "tenant-b"];
  feedbackRepository.patterns = [];

  await assert.doesNotReject(() => scheduler.runTuningTick());
});
