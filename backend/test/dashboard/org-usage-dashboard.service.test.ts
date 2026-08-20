import { test } from "node:test";
import assert from "node:assert/strict";
import { OrgUsageCacheService } from "../../src/dashboard/org-usage/org-usage-cache.service";
import { OrgUsageDashboardService } from "../../src/dashboard/org-usage/org-usage-dashboard.service";
import type { AgentConsumptionEntry, ConsumptionTrendPoint } from "../../src/dashboard/org-usage/org-usage-dashboard.types";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";

interface FakeState {
  totalCredits: number;
  totalDebits: number;
  activeAgents: number;
  recentConsumptionTotal: number;
  trend: ConsumptionTrendPoint[];
  agentBreakdown: AgentConsumptionEntry[];
  shouldThrow: boolean;
}

class FakeRepository {
  public state: FakeState = {
    totalCredits: 1000,
    totalDebits: 200,
    activeAgents: 5,
    recentConsumptionTotal: 70, // 10 credits/day over the 7-day burn-rate window
    trend: [{ date: "2026-08-01T00:00:00.000Z", credits: 50 }],
    agentBreakdown: [{ agentId: "agent-1", agentName: "Agent One", framework: "langchain", creditsConsumed: 50 }],
    shouldThrow: false,
  };

  async getOrgBalanceTotals(_client: unknown, _tenantId: string) {
    if (this.state.shouldThrow) throw new Error("simulated query timeout");
    return { totalCredits: this.state.totalCredits, totalDebits: this.state.totalDebits };
  }

  async getActiveAgentCount(_client: unknown, _tenantId: string) {
    return this.state.activeAgents;
  }

  async getRecentConsumptionTotal(_client: unknown, _tenantId: string, _days: number) {
    return this.state.recentConsumptionTotal;
  }

  async getConsumptionTrend(_client: unknown, _tenantId: string, _days: number, _granularity: string) {
    return this.state.trend;
  }

  async getAgentBreakdown(_client: unknown, _tenantId: string, _days: number) {
    return this.state.agentBreakdown;
  }
}

function buildRig() {
  const repository = new FakeRepository();
  const cache = new OrgUsageCacheService();
  const auditService = new InMemoryAuditService();
  const service = new OrgUsageDashboardService(repository as any, cache, auditService);
  return { repository, cache, service, auditService };
}

async function cleanup(rig: ReturnType<typeof buildRig>): Promise<void> {
  await rig.cache.onModuleDestroy();
}

test("computes balance as total minus consumed for a healthy tenant", async () => {
  const rig = buildRig();
  const result = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-1" });
  assert.deepEqual(result.balance, { total: 1000, consumed: 200, remaining: 800 });
  await cleanup(rig);
});

test("edge case: zero consumption tenant — burn rate is zero, no projected exhaustion date", async () => {
  const rig = buildRig();
  rig.repository.state.totalDebits = 0;
  rig.repository.state.recentConsumptionTotal = 0;
  const result = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-zero", actorId: "user-1" });
  assert.equal(result.balance.consumed, 0);
  assert.equal(result.burnRate.creditsPerDay, 0);
  assert.equal(result.burnRate.projectedExhaustionDate, null);
  await cleanup(rig);
});

test("edge case: near-cap tenant — remaining balance is small but positive, and a projected exhaustion date is computed", async () => {
  const rig = buildRig();
  rig.repository.state.totalCredits = 1000;
  rig.repository.state.totalDebits = 950;
  rig.repository.state.recentConsumptionTotal = 70; // 10 credits/day
  const result = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-near-cap", actorId: "user-1" });
  assert.equal(result.balance.remaining, 50);
  assert.ok(result.burnRate.projectedExhaustionDate !== null, "a positive remaining balance with nonzero burn rate must project an exhaustion date");
  await cleanup(rig);
});

test("edge case: over-cap tenant — consumption exceeds allocation, remaining clamps to zero (never negative) and exhaustion reads as already exhausted (null date)", async () => {
  const rig = buildRig();
  rig.repository.state.totalCredits = 500;
  rig.repository.state.totalDebits = 750;
  const result = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-over-cap", actorId: "user-1" });
  assert.equal(result.balance.remaining, 0, "remaining must never go negative even though consumed > total");
  assert.equal(result.burnRate.projectedExhaustionDate, null, "an already-exhausted balance reports null (rendered as 'Budget exhausted' by the frontend), not a nonsensical past/negative date");
  await cleanup(rig);
});

test("edge case: exactly-100%-of-cap tenant — balance is exactly zero remaining, burn rate still reflects the last known consumption rate", async () => {
  const rig = buildRig();
  rig.repository.state.totalCredits = 700;
  rig.repository.state.totalDebits = 700;
  rig.repository.state.recentConsumptionTotal = 70;
  const result = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-exact-cap", actorId: "user-1" });
  assert.equal(result.balance.remaining, 0);
  assert.equal(result.burnRate.creditsPerDay, 10, "burn rate is still reported (not zeroed out) even once the budget is exhausted");
  assert.equal(result.burnRate.projectedExhaustionDate, null);
  await cleanup(rig);
});

test("edge case: agent registered but never consumed credits still appears in the breakdown with zero consumption", async () => {
  const rig = buildRig();
  rig.repository.state.agentBreakdown = [
    { agentId: "agent-1", agentName: "Agent One", framework: "langchain", creditsConsumed: 50 },
    { agentId: "agent-2", agentName: "Never Used Agent", framework: "crewai", creditsConsumed: 0 },
  ];
  const result = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-1" });
  const neverUsed = result.agentBreakdown.find((a) => a.agentId === "agent-2");
  assert.ok(neverUsed, "an agent with zero consumption must still be present in the breakdown, not omitted");
  assert.equal(neverUsed?.creditsConsumed, 0);
  await cleanup(rig);
});

test("active agent count and consumption trend pass through from the repository", async () => {
  const rig = buildRig();
  const result = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-1" });
  assert.equal(result.activeAgents, 5);
  assert.deepEqual(result.consumptionTrend, [{ date: "2026-08-01T00:00:00.000Z", credits: 50 }]);
  await cleanup(rig);
});

test("falls back to the last-known-good cache when the live query fails, and marks the result as cached", async () => {
  const rig = buildRig();
  const first = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-cache", actorId: "user-1" });
  assert.equal(first.servedFromCache, false);

  rig.repository.state.shouldThrow = true;
  const second = await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-cache", actorId: "user-1" });

  assert.equal(second.servedFromCache, true);
  assert.deepEqual(second.balance, first.balance);
  await cleanup(rig);
});

test("with no cached snapshot available, a live query failure propagates instead of silently returning nothing", async () => {
  const rig = buildRig();
  rig.repository.state.shouldThrow = true;
  await assert.rejects(() => rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-never-cached", actorId: "user-1" }));
  await cleanup(rig);
});

test("records an org-usage-dashboard-view audit event on every successful read", async () => {
  const rig = buildRig();
  await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-1" });
  assert.equal(rig.auditService.events.length, 1);
  assert.equal(rig.auditService.events[0].action, "dashboard.org_usage_viewed");
  assert.equal(rig.auditService.events[0].tenantId, "tenant-a");
  assert.equal(rig.auditService.events[0].actorId, "user-1");
  await cleanup(rig);
});

test("records an audit event on the cache-fallback path too (a view still happened, even if served from cache)", async () => {
  const rig = buildRig();
  await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-cache-audit", actorId: "user-1" });
  rig.repository.state.shouldThrow = true;
  await rig.service.getOrgUsageSummary(undefined, { tenantId: "tenant-cache-audit", actorId: "user-1" });
  assert.equal(rig.auditService.events.length, 2);
  await cleanup(rig);
});

test("getBalance reads through to the repository and caches the result when there is no cached balance yet", async () => {
  const rig = buildRig();
  const balance = await rig.service.getBalance(undefined, "tenant-balance");
  assert.deepEqual(balance, { total: 1000, consumed: 200, remaining: 800 });

  // A second call with a changed underlying total must still return the CACHED value — proves the Redis-cache-first path is really taken, not silently bypassed.
  rig.repository.state.totalCredits = 99999;
  const cachedBalance = await rig.service.getBalance(undefined, "tenant-balance");
  assert.deepEqual(cachedBalance, { total: 1000, consumed: 200, remaining: 800 });
  await cleanup(rig);
});

test("getConsumption returns the trend and, when groupBy is supplied, the agent breakdown", async () => {
  const rig = buildRig();
  const withoutGroupBy = await rig.service.getConsumption(undefined, "tenant-a", 30, "daily", undefined);
  assert.deepEqual(withoutGroupBy.agentBreakdown, []);
  assert.equal(withoutGroupBy.trend.length, 1);

  const withGroupBy = await rig.service.getConsumption(undefined, "tenant-a", 30, "daily", "agent");
  assert.equal(withGroupBy.agentBreakdown.length, 1);
  await cleanup(rig);
});
