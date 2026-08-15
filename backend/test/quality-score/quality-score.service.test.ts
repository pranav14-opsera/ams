import { test } from "node:test";
import assert from "node:assert/strict";
import { QualityScoreService } from "../../src/quality-score/quality-score.service";

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: "baseline-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    baselineScore: null as number | null,
    calibrationStartedAt: new Date("2026-08-01T00:00:00Z"),
    establishedAt: null as Date | null,
    ...overrides,
  };
}

class FakeRepository {
  public toolCallSuccessRate: number | null = 0.9;
  public reasoningAccuracy: number | null = 0.8;
  public outputConsistency: number | null = 0.7;
  public config: { toolCallWeight: number; reasoningWeight: number; consistencyWeight: number } | null = null;
  public stored: unknown[] = [];
  public baseline: ReturnType<typeof makeBaseline> | null = null;
  public medianResult: { median: number | null; sampleCount: number } = { median: null, sampleCount: 0 };
  public establishedWith: number | null = null;
  public history: Array<{ computedAt: Date; compositeScore: number | null }> = [];
  public mostRecent: { compositeScore: number | null; toolCallScore: number | null; reasoningScore: number | null; consistencyScore: number | null; sampleCount: number; computedAt: Date } | null = null;

  async getToolCallSuccessRate() {
    return this.toolCallSuccessRate;
  }
  async getReasoningAccuracy() {
    return this.reasoningAccuracy;
  }
  async getOutputConsistency() {
    return this.outputConsistency;
  }
  async getConfig() {
    return this.config;
  }
  async storeScore(_client: unknown, tenantId: string, agentId: string, result: unknown, computedAt: Date) {
    const entry = { tenantId, agentId, ...(result as object), computedAt };
    this.stored.push(entry);
    return entry;
  }
  async ensureBaselineStarted(_client: unknown, tenantId: string, agentId: string) {
    this.baseline = makeBaseline({ tenantId, agentId });
    return this.baseline;
  }
  async findBaseline() {
    return this.baseline;
  }
  async getMedianScoreSince() {
    return this.medianResult;
  }
  async establishBaseline(_client: unknown, _tenantId: string, _agentId: string, score: number) {
    this.establishedWith = score;
    this.baseline = { ...this.baseline!, baselineScore: score, establishedAt: new Date() };
    return this.baseline;
  }
  async getScoreHistory() {
    return this.history.map((h, i) => ({ id: `h-${i}`, tenantId: "tenant-a", agentId: "agent-1", computedAt: h.computedAt, compositeScore: h.compositeScore, toolCallScore: null, reasoningScore: null, consistencyScore: null, sampleCount: 1 }));
  }
  async getMostRecentScore() {
    return this.mostRecent;
  }
  async upsertConfig(_client: unknown, tenantId: string, toolCallWeight: number, reasoningWeight: number, consistencyWeight: number) {
    this.config = { toolCallWeight, reasoningWeight, consistencyWeight };
    return { id: "config-1", tenantId, ...this.config };
  }
}

function buildRig() {
  const repository = new FakeRepository();
  const service = new QualityScoreService(repository as any);
  return { repository, service };
}

test("computeScoreForAgent uses default weights (40/35/25) when no tenant config exists", async () => {
  const { service } = buildRig();
  const result = await service.computeScoreForAgent(undefined, "tenant-a", "agent-1");
  // 90*0.40 + 80*0.35 + 70*0.25 = 81.5 -> 82
  assert.equal(result.compositeScore, 82);
});

test("computeScoreForAgent honors a custom tenant weight config over the defaults", async () => {
  const { repository, service } = buildRig();
  repository.config = { toolCallWeight: 100, reasoningWeight: 0, consistencyWeight: 0 };
  const result = await service.computeScoreForAgent(undefined, "tenant-a", "agent-1");
  assert.equal(result.compositeScore, 90);
});

test("computeAndStoreScoreForAgent persists the computed result via the repository", async () => {
  const { repository, service } = buildRig();
  await service.computeAndStoreScoreForAgent(undefined, "tenant-a", "agent-1");
  assert.equal(repository.stored.length, 1);
  assert.equal((repository.stored[0] as any).compositeScore, 82);
});

test("startCalibration delegates to ensureBaselineStarted", async () => {
  const { repository, service } = buildRig();
  await service.startCalibration(undefined, "tenant-a", "agent-1");
  assert.ok(repository.baseline);
});

test("checkAndEstablishBaseline: still within the 7-day window does nothing", async () => {
  const { repository, service } = buildRig();
  repository.baseline = makeBaseline({ calibrationStartedAt: new Date("2026-08-14T00:00:00Z") });
  const established = await service.checkAndEstablishBaseline(undefined, "tenant-a", "agent-1", new Date("2026-08-16T00:00:00Z"));
  assert.equal(established, false);
});

test("checkAndEstablishBaseline: already established is a no-op", async () => {
  const { repository, service } = buildRig();
  repository.baseline = makeBaseline({ establishedAt: new Date("2026-08-08T00:00:00Z") });
  const established = await service.checkAndEstablishBaseline(undefined, "tenant-a", "agent-1", new Date("2026-08-16T00:00:00Z"));
  assert.equal(established, false);
});

test("checkAndEstablishBaseline: window elapsed with no scored history is deferred", async () => {
  const { repository, service } = buildRig();
  repository.baseline = makeBaseline({ calibrationStartedAt: new Date("2026-08-01T00:00:00Z") });
  repository.medianResult = { median: null, sampleCount: 0 };
  const established = await service.checkAndEstablishBaseline(undefined, "tenant-a", "agent-1", new Date("2026-08-16T00:00:00Z"));
  assert.equal(established, false);
});

test("checkAndEstablishBaseline: window elapsed with real scored history establishes the median as baseline", async () => {
  const { repository, service } = buildRig();
  repository.baseline = makeBaseline({ calibrationStartedAt: new Date("2026-08-01T00:00:00Z") });
  repository.medianResult = { median: 78, sampleCount: 500 };
  const established = await service.checkAndEstablishBaseline(undefined, "tenant-a", "agent-1", new Date("2026-08-16T00:00:00Z"));
  assert.equal(established, true);
  assert.equal(repository.establishedWith, 78);
});

test("checkAndEstablishBaseline: no baseline record at all is a no-op", async () => {
  const { repository, service } = buildRig();
  repository.baseline = null;
  const established = await service.checkAndEstablishBaseline(undefined, "tenant-a", "agent-1");
  assert.equal(established, false);
});

test("getAgentSummary: color indicator is green >= 80, amber 60-79, red < 60", async () => {
  const { repository, service } = buildRig();
  repository.mostRecent = { compositeScore: 85, toolCallScore: 90, reasoningScore: 80, consistencyScore: 85, sampleCount: 3, computedAt: new Date() };
  const green = await service.getAgentSummary(undefined, "tenant-a", "agent-1");
  assert.equal(green.colorIndicator, "green");

  repository.mostRecent = { compositeScore: 65, toolCallScore: 60, reasoningScore: 70, consistencyScore: 65, sampleCount: 3, computedAt: new Date() };
  const amber = await service.getAgentSummary(undefined, "tenant-a", "agent-1");
  assert.equal(amber.colorIndicator, "amber");

  repository.mostRecent = { compositeScore: 40, toolCallScore: 30, reasoningScore: 45, consistencyScore: 45, sampleCount: 3, computedAt: new Date() };
  const red = await service.getAgentSummary(undefined, "tenant-a", "agent-1");
  assert.equal(red.colorIndicator, "red");
});

test("getAgentSummary: no scored history at all returns a null current score and null color, not fabricated values", async () => {
  const { service } = buildRig();
  const summary = await service.getAgentSummary(undefined, "tenant-a", "agent-1");
  assert.equal(summary.current, null);
  assert.equal(summary.colorIndicator, null);
});

test("getAgentSummary: an agent still calibrating reports daysRemaining and calibrating=true", async () => {
  const { repository, service } = buildRig();
  repository.baseline = makeBaseline({ calibrationStartedAt: new Date("2026-08-13T00:00:00Z") }); // 3 days ago of a 7-day window
  const summary = await service.getAgentSummary(undefined, "tenant-a", "agent-1", new Date("2026-08-16T00:00:00Z"));
  assert.equal(summary.baseline?.calibrating, true);
  assert.equal(summary.baseline?.daysRemaining, 4);
});

test("getAgentSummary: an established baseline reports calibrating=false and daysRemaining=0", async () => {
  const { repository, service } = buildRig();
  repository.baseline = makeBaseline({ establishedAt: new Date("2026-08-08T00:00:00Z"), baselineScore: 78 });
  const summary = await service.getAgentSummary(undefined, "tenant-a", "agent-1");
  assert.equal(summary.baseline?.calibrating, false);
  assert.equal(summary.baseline?.daysRemaining, 0);
  assert.equal(summary.baseline?.score, 78);
});

test("setWeights delegates to upsertConfig and returns the new weights", async () => {
  const { service } = buildRig();
  const weights = await service.setWeights(undefined, "tenant-a", 50, 30, 20);
  assert.deepEqual(weights, { toolCall: 50, reasoning: 30, consistency: 20 });
});
