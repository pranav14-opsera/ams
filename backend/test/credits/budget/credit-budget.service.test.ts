import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditBudgetService } from "../../../src/credits/budget/credit-budget.service";

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-1",
    allocatedCredits: 1000,
    alertThreshold75: true,
    alertThreshold90: true,
    hardCap: null,
    effectiveMonth: 8,
    effectiveYear: 2026,
    justification: "initial allocation",
    ...overrides,
  };
}

class FakeClient {
  public queries: string[] = [];
  async query(sql: string) {
    this.queries.push(sql);
    return { rows: [] };
  }
  release() {
    /* no-op */
  }
}

class FakePool {
  public client = new FakeClient();
  async connect() {
    return this.client;
  }
}

class FakeRepository {
  public pool: { totalCredits: number } | null = { totalCredits: 5000 };
  public existingBudgets = new Map<string, { allocatedCredits: number }>();
  public upserted: unknown[] = [];

  async findPoolForUpdate() {
    return this.pool ? { id: "pool-1", tenantId: "tenant-a", totalCredits: this.pool.totalCredits, effectiveMonth: 8, effectiveYear: 2026 } : null;
  }
  async findBudget(_client: unknown, _tenantId: string, teamId: string) {
    const existing = this.existingBudgets.get(teamId);
    return existing ? { id: `budget-${teamId}`, tenantId: "tenant-a", teamId, allocatedCredits: existing.allocatedCredits, alertThreshold75: true, alertThreshold90: true, hardCap: null, effectiveMonth: 8, effectiveYear: 2026, createdBy: null } : null;
  }
  async sumAllocatedForPeriod(_client: unknown, _tenantId: string, _month: number, _year: number, excludeTeamId?: string) {
    let sum = 0;
    for (const [teamId, budget] of this.existingBudgets) {
      if (teamId !== excludeTeamId) sum += budget.allocatedCredits;
    }
    return sum;
  }
  async upsertBudget(_client: unknown, tenantId: string, actorId: string | null, request: Record<string, unknown>) {
    this.existingBudgets.set(request.teamId as string, { allocatedCredits: request.allocatedCredits as number });
    const budget = { id: `budget-${request.teamId}`, tenantId, createdBy: actorId, ...request };
    this.upserted.push(budget);
    return budget;
  }
  async getConsumedCreditsForPeriod() {
    return 250;
  }
  async getTrailing30DayDailyAverage() {
    return 10;
  }
}

class FakeAuditService {
  public events: unknown[] = [];
  async recordEvent(event: unknown) {
    this.events.push(event);
  }
}

function buildRig() {
  const pool = new FakePool();
  const repository = new FakeRepository();
  const auditService = new FakeAuditService();
  const service = new CreditBudgetService(pool as any, repository as any, auditService as any);
  return { pool, repository, auditService, service };
}

test("allocate: a request within the pool's remaining capacity succeeds and is audited", async () => {
  const { repository, auditService, service } = buildRig();
  const budget = await service.allocate("tenant-a", "user-1", makeRequest());
  assert.equal(budget.allocatedCredits, 1000);
  assert.equal(repository.upserted.length, 1);
  assert.equal(auditService.events.length, 1);
  assert.equal((auditService.events[0] as any).action, "credit_budget.allocated");
});

test("allocate: a request that would exceed the org pool is rejected with a clear message, and never written", async () => {
  const { repository, service } = buildRig();
  repository.existingBudgets.set("team-2", { allocatedCredits: 4500 }); // only 500 credits of the 5000 pool remain

  await assert.rejects(() => service.allocate("tenant-a", "user-1", makeRequest({ teamId: "team-1", allocatedCredits: 1000 })), (err: any) => {
    assert.ok(err.message.includes("would bring the total allocated"));
    return true;
  });
  assert.equal(repository.upserted.length, 0);
});

test("allocate: updating an EXISTING team's own allocation excludes its own current value from the pool-capacity check", async () => {
  const { repository, service } = buildRig();
  repository.existingBudgets.set("team-1", { allocatedCredits: 4000 }); // team-1 already has 4000 of the 5000 pool

  // Increasing team-1's own allocation to 4800 should succeed — its OLD 4000 must not be double-counted against the pool.
  const budget = await service.allocate("tenant-a", "user-1", makeRequest({ teamId: "team-1", allocatedCredits: 4800 }));
  assert.equal(budget.allocatedCredits, 4800);
});

test("allocate: no organization credit pool configured for the period is rejected with a clear message", async () => {
  const { repository, service } = buildRig();
  repository.pool = null;

  await assert.rejects(() => service.allocate("tenant-a", "user-1", makeRequest()), (err: any) => {
    assert.ok(err.message.includes("No organization credit pool is configured"));
    return true;
  });
});

test("allocate: the transaction is rolled back (ROLLBACK issued) when an over-allocation is rejected", async () => {
  const { pool, repository, service } = buildRig();
  repository.existingBudgets.set("team-2", { allocatedCredits: 5000 }); // pool fully allocated already

  await assert.rejects(() => service.allocate("tenant-a", "user-1", makeRequest()));
  assert.ok(pool.client.queries.includes("ROLLBACK"));
  assert.ok(!pool.client.queries.includes("COMMIT"));
});

test("getTeamBudget computes consumed/remaining/consumption percentage and a projected exhaustion date from real trailing-30-day consumption", async () => {
  const { service } = buildRig();
  await service.allocate("tenant-a", "user-1", makeRequest({ teamId: "team-1", allocatedCredits: 1000 }));

  const summary = await service.getTeamBudget(undefined, "tenant-a", "team-1", 8, 2026, new Date("2026-08-15T00:00:00Z"));
  assert.equal(summary.allocatedCredits, 1000);
  assert.equal(summary.consumedCredits, 250);
  assert.equal(summary.remainingCredits, 750);
  assert.equal(summary.consumptionPercentage, 25);
  assert.ok(summary.projectedExhaustionDate !== null); // 750 remaining / 10 per day = 75 days out
});

test("getTeamBudget throws NotFoundException when no budget exists for that team/period", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.getTeamBudget(undefined, "tenant-a", "no-such-team", 8, 2026));
});

test("consumptionPercentage is null (not a fabricated 0 or division-by-zero) when allocatedCredits is 0", async () => {
  const { repository, service } = buildRig();
  repository.getConsumedCreditsForPeriod = async () => 0;
  await service.allocate("tenant-a", "user-1", makeRequest({ teamId: "team-1", allocatedCredits: 0 }));

  const summary = await service.getTeamBudget(undefined, "tenant-a", "team-1", 8, 2026);
  assert.equal(summary.consumptionPercentage, null);
});

test("projectedExhaustionDate is null when there's no recent consumption trend to project from (zero daily average)", async () => {
  const { repository, service } = buildRig();
  repository.getTrailing30DayDailyAverage = async () => 0;
  await service.allocate("tenant-a", "user-1", makeRequest({ teamId: "team-1", allocatedCredits: 1000 }));

  const summary = await service.getTeamBudget(undefined, "tenant-a", "team-1", 8, 2026);
  assert.equal(summary.projectedExhaustionDate, null);
});
