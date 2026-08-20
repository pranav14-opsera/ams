import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import { TeamUsageCacheService } from "../../src/dashboard/team-usage/team-usage-cache.service";
import { TeamUsageDashboardService } from "../../src/dashboard/team-usage/team-usage-dashboard.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";

interface FakeRow {
  bucket: Date;
  agent_id: string;
  agent_name: string;
  framework: string;
  credits: string;
}

class FakeRepository {
  public team: { id: string; name: string } | null = { id: "team-a", name: "Team A" };
  public tenantTeams: Array<{ id: string; name: string }> = [{ id: "team-a", name: "Team A" }];
  public userTeams: Array<{ id: string; name: string }> = [{ id: "team-a", name: "Team A" }];
  public agentCount = 5;
  public recentTotal = 70; // 10 credits/day burn rate over the 7-day window
  public rows: FakeRow[] = [];
  public roster: Array<{ id: string; name: string; framework: string }> = [];
  public shouldThrow = false;

  async getTeam(_client: unknown, _tenantId: string, _teamId: string) {
    return this.team;
  }
  async listTeamsForTenant(_client: unknown, _tenantId: string) {
    return this.tenantTeams;
  }
  async listTeamsForUser(_client: unknown, _tenantId: string, _userId: string) {
    return this.userTeams;
  }
  async getTeamAgentCount(_client: unknown, _tenantId: string, _teamId: string) {
    if (this.shouldThrow) throw new Error("simulated query failure");
    return this.agentCount;
  }
  async getRecentTeamConsumptionTotal(_client: unknown, _tenantId: string, _teamId: string, _days: number) {
    return this.recentTotal;
  }
  async getTeamConsumptionRows(_client: unknown, _tenantId: string, _teamId: string, _days: number, _granularity: string, _filters: unknown) {
    return this.rows;
  }
  async getTeamAgentRoster(_client: unknown, _tenantId: string, _teamId: string, _frameworks: string[] | undefined) {
    return this.roster;
  }
}

class FakeCreditBudgetService {
  public summary: { allocatedCredits: number; consumedCredits: number; remainingCredits: number; consumptionPercentage: number | null } | "not_found" = {
    allocatedCredits: 1000,
    consumedCredits: 200,
    remainingCredits: 800,
    consumptionPercentage: 20,
  };

  async getTeamBudget() {
    if (this.summary === "not_found") throw new NotFoundException("no budget");
    return this.summary;
  }
}

class FakeTeamMembershipRepository {
  public teamIdsByUser = new Map<string, string[]>([["user-lead", ["team-a"]]]);
  async getUserTeamIds(_tenantId: string, userId: string) {
    return this.teamIdsByUser.get(userId) ?? [];
  }
}

function buildRig() {
  const repository = new FakeRepository();
  const cache = new TeamUsageCacheService();
  const creditBudgetService = new FakeCreditBudgetService();
  const teamMembershipRepository = new FakeTeamMembershipRepository();
  const auditService = new InMemoryAuditService();
  const service = new TeamUsageDashboardService(repository as any, cache, creditBudgetService as any, teamMembershipRepository as any, auditService);
  return { repository, cache, creditBudgetService, teamMembershipRepository, service, auditService };
}

async function cleanup(rig: ReturnType<typeof buildRig>): Promise<void> {
  await rig.cache.onModuleDestroy();
}

test("resolveTeamId: an org-scoped caller (e.g. platform_admin) with an explicit team_id gets that team back unchanged", async () => {
  const rig = buildRig();
  const teamId = await rig.service.resolveTeamId(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] }, "team-b");
  assert.equal(teamId, "team-b");
  await cleanup(rig);
});

test("resolveTeamId: an org-scoped caller with NO team_id defaults to the tenant's first team", async () => {
  const rig = buildRig();
  rig.repository.tenantTeams = [
    { id: "team-x", name: "Team X" },
    { id: "team-y", name: "Team Y" },
  ];
  const teamId = await rig.service.resolveTeamId(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] }, undefined);
  assert.equal(teamId, "team-x");
  await cleanup(rig);
});

test("resolveTeamId: an org-scoped caller in a tenant with zero teams gets a guidance NotFoundException, not a crash", async () => {
  const rig = buildRig();
  rig.repository.tenantTeams = [];
  await assert.rejects(
    () => rig.service.resolveTeamId(undefined, { tenantId: "tenant-empty", actorId: "admin-1", roles: ["platform_admin"] }, undefined),
    (err: any) => err instanceof NotFoundException,
  );
  await cleanup(rig);
});

test("resolveTeamId: a Team Lead requesting their OWN team is allowed", async () => {
  const rig = buildRig();
  const teamId = await rig.service.resolveTeamId(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] }, "team-a");
  assert.equal(teamId, "team-a");
  await cleanup(rig);
});

test("AC 5 / CONSTRAINTS: a Team Lead requesting a DIFFERENT team is denied outright — zero cross-team leakage", async () => {
  const rig = buildRig();
  await assert.rejects(() => rig.service.resolveTeamId(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] }, "team-b"));
  await cleanup(rig);
});

test("resolveTeamId: a Team Lead who omits team_id entirely is denied (never silently substituted)", async () => {
  const rig = buildRig();
  await assert.rejects(() => rig.service.resolveTeamId(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] }, undefined));
  await cleanup(rig);
});

test("listSelectableTeams: platform_admin sees every team in the tenant", async () => {
  const rig = buildRig();
  rig.repository.tenantTeams = [
    { id: "team-a", name: "Team A" },
    { id: "team-b", name: "Team B" },
    { id: "team-c", name: "Team C" },
  ];
  const teams = await rig.service.listSelectableTeams(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] });
  assert.equal(teams.length, 3);
  await cleanup(rig);
});

test("listSelectableTeams: edge case — a Team Lead belonging to multiple teams sees only THEIR teams, not the tenant's full list", async () => {
  const rig = buildRig();
  rig.repository.userTeams = [
    { id: "team-a", name: "Team A" },
    { id: "team-z", name: "Team Z" },
  ];
  rig.repository.tenantTeams = [
    { id: "team-a", name: "Team A" },
    { id: "team-b", name: "Team B" },
    { id: "team-z", name: "Team Z" },
  ];
  const teams = await rig.service.listSelectableTeams(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] });
  assert.deepEqual(
    teams.map((t) => t.id).sort(),
    ["team-a", "team-z"],
  );
  await cleanup(rig);
});

test("getTeamUsageSummary: computes the team balance from CreditBudgetService's own team-budget calculation, not a re-derived one", async () => {
  const rig = buildRig();
  const result = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] }, "team-a");
  assert.deepEqual(result.balance, { allocated: 1000, consumed: 200, remaining: 800, utilizationPct: 20 });
  await cleanup(rig);
});

test("edge case: a team with no budget allocation at all reports an honest zero/un-budgeted balance instead of erroring out", async () => {
  const rig = buildRig();
  rig.creditBudgetService.summary = "not_found";
  rig.repository.recentTotal = 0;
  const result = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] }, "team-a");
  assert.equal(result.balance.allocated, 0);
  assert.equal(result.balance.utilizationPct, null);
  await cleanup(rig);
});

test("getTeamUsageSummary: unknown team_id raises NotFoundException", async () => {
  const rig = buildRig();
  rig.repository.team = null;
  await assert.rejects(
    () => rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] }, "ghost-team"),
    (err: any) => err instanceof NotFoundException,
  );
  await cleanup(rig);
});

test("edge case: zero-agent team returns an empty agent comparison and trend, not an error", async () => {
  const rig = buildRig();
  rig.repository.agentCount = 0;
  rig.repository.roster = [];
  rig.repository.rows = [];
  const result = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] }, "team-a");
  assert.equal(result.agentCount, 0);
  assert.deepEqual(result.agentComparison, []);
  assert.deepEqual(result.consumptionTrend, []);
  await cleanup(rig);
});

test("AC 4: an agent consuming more than 2x the team's mean is flagged isAboveThreshold, others are not", async () => {
  const rig = buildRig();
  rig.repository.roster = [
    { id: "agent-1", name: "Normal Agent", framework: "langchain" },
    { id: "agent-2", name: "Also Normal", framework: "crewai" },
    { id: "agent-3", name: "Hotspot Agent", framework: "langchain" },
  ];
  // mean = (10 + 10 + 80) / 3 = 33.33 -> 2x mean = 66.67 -> only agent-3 (80) exceeds it.
  rig.repository.rows = [
    { bucket: new Date("2026-08-01T00:00:00Z"), agent_id: "agent-1", agent_name: "Normal Agent", framework: "langchain", credits: "10" },
    { bucket: new Date("2026-08-01T00:00:00Z"), agent_id: "agent-2", agent_name: "Also Normal", framework: "crewai", credits: "10" },
    { bucket: new Date("2026-08-01T00:00:00Z"), agent_id: "agent-3", agent_name: "Hotspot Agent", framework: "langchain", credits: "80" },
  ];
  const result = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] }, "team-a");
  const byId = new Map(result.agentComparison.map((a) => [a.agentId, a]));
  assert.equal(byId.get("agent-1")?.isAboveThreshold, false);
  assert.equal(byId.get("agent-2")?.isAboveThreshold, false);
  assert.equal(byId.get("agent-3")?.isAboveThreshold, true);
  await cleanup(rig);
});

test("edge case: an agent in the team roster with zero matching consumption still appears in the comparison, not silently dropped", async () => {
  const rig = buildRig();
  rig.repository.roster = [
    { id: "agent-1", name: "Active Agent", framework: "langchain" },
    { id: "agent-2", name: "Never Used Agent", framework: "crewai" },
  ];
  rig.repository.rows = [{ bucket: new Date("2026-08-01T00:00:00Z"), agent_id: "agent-1", agent_name: "Active Agent", framework: "langchain", credits: "40" }];
  const result = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] }, "team-a");
  const neverUsed = result.agentComparison.find((a) => a.agentId === "agent-2");
  assert.ok(neverUsed, "a roster agent with zero consumption must still appear");
  assert.equal(neverUsed?.creditsConsumed, 0);
  await cleanup(rig);
});

test("framework values are translated from the DB's 'generic_rest' to this WO's own wire vocabulary 'rest'", async () => {
  const rig = buildRig();
  rig.repository.roster = [{ id: "agent-1", name: "REST Connector", framework: "generic_rest" }];
  rig.repository.rows = [];
  const result = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] }, "team-a");
  assert.equal(result.agentComparison[0]?.framework, "rest");
  await cleanup(rig);
});

test("consumption trend sums across every agent within the same bucket into one team-wide point", async () => {
  const rig = buildRig();
  rig.repository.rows = [
    { bucket: new Date("2026-08-01T00:00:00Z"), agent_id: "agent-1", agent_name: "A", framework: "langchain", credits: "10" },
    { bucket: new Date("2026-08-01T00:00:00Z"), agent_id: "agent-2", agent_name: "B", framework: "crewai", credits: "15" },
    { bucket: new Date("2026-08-02T00:00:00Z"), agent_id: "agent-1", agent_name: "A", framework: "langchain", credits: "5" },
  ];
  const result = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "admin-1", roles: ["platform_admin"] }, "team-a");
  assert.deepEqual(result.consumptionTrend, [
    { date: "2026-08-01T00:00:00.000Z", credits: 25 },
    { date: "2026-08-02T00:00:00.000Z", credits: 5 },
  ]);
  await cleanup(rig);
});

test("falls back to the last-known-good cache when a live query fails, scoped per team+filter combination", async () => {
  const rig = buildRig();
  const first = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-cache", actorId: "admin-1", roles: ["platform_admin"] }, "team-a");
  assert.equal(first.servedFromCache, false);

  rig.repository.shouldThrow = true;
  const second = await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-cache", actorId: "admin-1", roles: ["platform_admin"] }, "team-a");
  assert.equal(second.servedFromCache, true);
  assert.deepEqual(second.balance, first.balance);
  await cleanup(rig);
});

test("records a team-usage-dashboard-view audit event, including team_id and filters, on every successful read", async () => {
  const rig = buildRig();
  await rig.service.getTeamUsageSummary(undefined, { tenantId: "tenant-a", actorId: "user-lead", roles: ["team_lead"] }, "team-a", "30d", "daily", { frameworks: ["langchain"] });
  assert.equal(rig.auditService.events.length, 1);
  assert.equal(rig.auditService.events[0].action, "dashboard.team_usage_viewed");
  assert.equal((rig.auditService.events[0].details as any).teamId, "team-a");
  assert.deepEqual((rig.auditService.events[0].details as any).filters, { frameworks: ["langchain"] });
  await cleanup(rig);
});
