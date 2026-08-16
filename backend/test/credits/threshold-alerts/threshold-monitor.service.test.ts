import { test } from "node:test";
import assert from "node:assert/strict";
import { ThresholdMonitorService } from "../../../src/credits/threshold-alerts/threshold-monitor.service";

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-1",
    allocatedCredits: 1000,
    consumedCredits: 750,
    remainingCredits: 250,
    consumptionPercentage: 75,
    alertThreshold75: true,
    alertThreshold90: true,
    hardCap: null,
    effectiveMonth: 8,
    effectiveYear: 2026,
    projectedExhaustionDate: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

class FakeBudgetService {
  public summaries = new Map<string, ReturnType<typeof makeSummary>>();
  async getTeamBudget(_client: unknown, _tenantId: string, teamId: string) {
    const summary = this.summaries.get(teamId);
    if (!summary) throw new Error("NotFoundException: no budget");
    return summary;
  }
}

class FakeAlertRepository {
  public created = new Map<string, { id: string }>();
  public teamNames = new Map<string, string>();
  public teamLeadEmails = new Map<string, string[]>();
  public financeManagerEmails: string[] = ["finance@example.com"];

  async tryCreateAlert(_client: unknown, tenantId: string, teamId: string, thresholdLevel: number, consumptionPercentage: number, month: number, year: number) {
    const key = `${tenantId}:${teamId}:${thresholdLevel}:${month}:${year}`;
    if (this.created.has(key)) return null; // duplicate
    const alert = { id: `alert-${this.created.size + 1}`, tenantId, teamId, thresholdLevel, consumptionPercentage, effectiveMonth: month, effectiveYear: year, generatedAt: new Date() };
    this.created.set(key, alert);
    return alert;
  }
  async getTeamName(_client: unknown, _tenantId: string, teamId: string) {
    return this.teamNames.get(teamId) ?? null;
  }
  async findTeamLeadEmails(_client: unknown, _tenantId: string, teamId: string) {
    return this.teamLeadEmails.get(teamId) ?? [];
  }
  async findFinanceManagerEmails() {
    return this.financeManagerEmails;
  }
}

class FakeDeliveryService {
  public delivered: Array<{ tenantId: string; payload: unknown; recipients: string[] }> = [];
  async deliver(tenantId: string, payload: unknown, recipients: string[]) {
    this.delivered.push({ tenantId, payload, recipients });
  }
}

function buildRig() {
  const budgetService = new FakeBudgetService();
  const alertRepository = new FakeAlertRepository();
  const deliveryService = new FakeDeliveryService();
  const service = new ThresholdMonitorService(budgetService as any, alertRepository as any, deliveryService as any);
  return { budgetService, alertRepository, deliveryService, service };
}

test("a team at exactly 75% generates a 75% alert, delivered to team lead + finance manager", async () => {
  const { budgetService, alertRepository, deliveryService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 75 }));
  alertRepository.teamNames.set("team-1", "Team Alpha");
  alertRepository.teamLeadEmails.set("team-1", ["lead@example.com"]);

  const generated = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].thresholdLevel, 75);
  assert.equal(deliveryService.delivered.length, 1);
  assert.deepEqual(deliveryService.delivered[0].recipients.sort(), ["finance@example.com", "lead@example.com"]);
});

test("boundary values: 74% generates no alert, 76% generates a 75% alert", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 74 }));
  const belowResult = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.equal(belowResult.length, 0);

  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 76 }));
  const aboveResult = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.equal(aboveResult.length, 1);
  assert.equal(aboveResult[0].thresholdLevel, 75);
});

test("boundary values: 89% generates only a 75% alert (not 90%), 91% generates BOTH 75% and 90% alerts", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 89 }));
  const at89 = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.deepEqual(at89.map((a) => a.thresholdLevel).sort(), [75]);

  budgetService.summaries.set("team-2", makeSummary({ teamId: "team-2", consumptionPercentage: 91 }));
  const at91 = await service.evaluateThresholds(undefined, "tenant-a", ["team-2"], 8, 2026);
  assert.deepEqual(at91.map((a) => a.thresholdLevel).sort(), [75, 90]);
});

test("exactly 90% generates both the 75% and 90% alerts (both thresholds are simultaneously crossed)", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 90 }));
  const generated = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.deepEqual(generated.map((a) => a.thresholdLevel).sort(), [75, 90]);
});

test("deduplication: re-evaluating the SAME team/period never generates a second alert for an already-crossed threshold", async () => {
  const { budgetService, deliveryService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 80 }));

  const first = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.equal(first.length, 1);

  const second = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.equal(second.length, 0, "the 75% threshold was already alerted this period — must not fire again");
  assert.equal(deliveryService.delivered.length, 1, "only the first evaluation's alert should have been delivered");
});

test("a team crossing 90% later in the SAME period as an earlier 75% alert still gets a genuinely NEW 90% alert", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 78 }));
  const first = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.deepEqual(first.map((a) => a.thresholdLevel), [75]);

  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 92 }));
  const second = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.deepEqual(second.map((a) => a.thresholdLevel), [90], "75% must not re-fire, but 90% is a genuinely new threshold crossing");
});

test("zero-allocation guard: a team with a null consumptionPercentage (0 allocated credits) never generates an alert", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: null }));

  const generated = await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  assert.equal(generated.length, 0);
});

test("a team with no budget configured at all for this period is skipped without throwing", async () => {
  const { service } = buildRig();
  const generated = await service.evaluateThresholds(undefined, "tenant-a", ["no-such-team"], 8, 2026);
  assert.equal(generated.length, 0);
});

test("a failure evaluating one team doesn't stop the rest of the batch from being evaluated", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-2", makeSummary({ teamId: "team-2", consumptionPercentage: 80 }));
  // team-1 has no summary at all -> throws inside getTeamBudget -> caught internally

  const generated = await service.evaluateThresholds(undefined, "tenant-a", ["team-1", "team-2"], 8, 2026);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].teamId, "team-2");
});

test("alert payload carries all AC-required fields, including the recommended action", async () => {
  const { budgetService, alertRepository, deliveryService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumptionPercentage: 92, allocatedCredits: 2000, consumedCredits: 1840, remainingCredits: 160 }));
  alertRepository.teamNames.set("team-1", "Team Alpha");

  await service.evaluateThresholds(undefined, "tenant-a", ["team-1"], 8, 2026);
  const ninetyPercentDelivery = deliveryService.delivered.find((d) => (d.payload as any).thresholdLevel === 90)!;
  const payload = ninetyPercentDelivery.payload as any;
  assert.equal(payload.teamName, "Team Alpha");
  assert.equal(payload.allocatedCredits, 2000);
  assert.equal(payload.consumedCredits, 1840);
  assert.equal(payload.remainingCredits, 160);
  assert.equal(payload.consumptionPercentage, 92);
  assert.ok(typeof payload.recommendedAction === "string" && payload.recommendedAction.length > 0);
  assert.ok(payload.recommendedAction.toLowerCase().includes("immediate"), "the 90% alert's recommended action should convey elevated urgency");
});
