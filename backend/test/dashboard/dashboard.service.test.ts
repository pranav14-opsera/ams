import { test } from "node:test";
import assert from "node:assert/strict";
import { DashboardService } from "../../src/dashboard/dashboard.service";
import type { ListAgentHealthQueryDto } from "../../src/dashboard/dto/list-agent-health-query.dto";
import { HealthCacheService } from "../../src/dashboard/health-cache.service";
import type { AgentHealthFilters, AgentHealthRow } from "../../src/dashboard/health-dashboard.repository";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";

function makeRow(overrides: Partial<AgentHealthRow> = {}): AgentHealthRow {
  return {
    id: "agent-1",
    tenantId: "tenant-a",
    teamId: "team-1",
    name: "Claims Processor",
    framework: "langchain",
    lifecycleStatus: "active",
    latencyP50Ms: 100,
    latencyP99Ms: 200,
    errorRateAvg: 0,
    tokenConsumptionTotal: 500,
    toolCallSuccessRateAvg: 0.99,
    metricsBucket: new Date("2026-08-16T00:00:00Z"),
    ...overrides,
  };
}

class FakeRepository {
  public lastFilters: AgentHealthFilters | undefined;
  public rows: AgentHealthRow[] = [makeRow()];
  public total = 1;
  public shouldThrow = false;

  async findFleetHealth(_client: unknown, _tenantId: string, filters: AgentHealthFilters) {
    this.lastFilters = filters;
    if (this.shouldThrow) throw new Error("simulated query timeout");
    return { rows: this.rows, total: this.total };
  }
}

class FakeTeamMembershipRepository {
  public teamIdsByUser = new Map<string, string[]>();
  async getUserTeamIds(_tenantId: string, userId: string): Promise<string[]> {
    return this.teamIdsByUser.get(userId) ?? [];
  }
}

function buildRig() {
  const repository = new FakeRepository();
  const teamMembershipRepository = new FakeTeamMembershipRepository();
  const cache = new HealthCacheService();
  const phiScrubber = new PhiScrubberService();
  const auditService = new InMemoryAuditService();
  const service = new DashboardService(repository as any, teamMembershipRepository as any, cache, phiScrubber, auditService);
  return { repository, teamMembershipRepository, cache, service, auditService };
}

const NO_FILTERS: ListAgentHealthQueryDto = {};

test("platform_admin gets no team restriction (teamIds passed as null)", async () => {
  const { repository, service } = buildRig();
  await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, NO_FILTERS);
  assert.equal(repository.lastFilters?.teamIds, null);
  await cleanup(repository, service);
});

test("team_lead is scoped to their own team memberships", async () => {
  const { repository, teamMembershipRepository, service } = buildRig();
  teamMembershipRepository.teamIdsByUser.set("user-2", ["team-9"]);
  await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-2", roles: ["team_lead"] }, NO_FILTERS);
  assert.deepEqual(repository.lastFilters?.teamIds, ["team-9"]);
  await cleanup(repository, service);
});

test("agent_operator is scoped the same way as team_lead (no finer 'assigned' concept exists)", async () => {
  const { repository, teamMembershipRepository, service } = buildRig();
  teamMembershipRepository.teamIdsByUser.set("user-3", ["team-5"]);
  await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-3", roles: ["agent_operator"] }, NO_FILTERS);
  assert.deepEqual(repository.lastFilters?.teamIds, ["team-5"]);
  await cleanup(repository, service);
});

test("a role with no team membership at all is scoped to an empty teamIds array (a real repository given [] returns zero agents)", async () => {
  const { repository, service } = buildRig();
  await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-4", roles: ["team_lead"] }, NO_FILTERS);
  assert.deepEqual(repository.lastFilters?.teamIds, [], "the fake repository doesn't itself filter on teamIds — this asserts the SCOPE the service passes down, which HealthDashboardRepository's own findFleetHealth (see its `filters.teamIds.length === 0` short-circuit) turns into zero rows");
  await cleanup(repository, service);
});

test("an unrecognized/no role is scoped to zero agents (deny by default)", async () => {
  const { repository, service } = buildRig();
  await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-5", roles: [] }, NO_FILTERS);
  assert.deepEqual(repository.lastFilters?.teamIds, []);
  await cleanup(repository, service);
});

test("computes the fleet summary percentages from the returned agents", async () => {
  const { repository, service } = buildRig();
  repository.rows = [
    makeRow({ id: "a1", lifecycleStatus: "active", errorRateAvg: 0 }),
    makeRow({ id: "a2", lifecycleStatus: "active", errorRateAvg: 0.9 }), // -> error
    makeRow({ id: "a3", lifecycleStatus: "paused" }),
    makeRow({ id: "a4", lifecycleStatus: "retired" }),
  ];
  repository.total = 4;

  const result = await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, NO_FILTERS);

  assert.equal(result.summary.totalAgents, 4);
  assert.equal(result.summary.activePct, 25);
  assert.equal(result.summary.errorPct, 25);
  assert.equal(result.summary.pausedPct, 25);
  assert.equal(result.summary.retiredPct, 25);
  await cleanup(repository, service);
});

test("filtering by unified health status is applied after status derivation, not pushed to the repository", async () => {
  const { repository, service } = buildRig();
  repository.rows = [makeRow({ id: "a1", lifecycleStatus: "active", errorRateAvg: 0 }), makeRow({ id: "a2", lifecycleStatus: "active", errorRateAvg: 0.9 })];
  repository.total = 2;

  const result = await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, { status: "error" } as ListAgentHealthQueryDto);

  assert.deepEqual(
    result.agents.map((a) => a.id),
    ["a2"],
  );
  await cleanup(repository, service);
});

test("agent name is PHI-scrubbed before being returned", async () => {
  const { repository, service } = buildRig();
  repository.rows = [makeRow({ name: "Patient SSN 123-45-6789 handler" })];

  const result = await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, NO_FILTERS);

  assert.ok(!result.agents[0].name.includes("123-45-6789"), "an SSN-shaped value embedded in an agent name must never reach the response");
  await cleanup(repository, service);
});

test("falls back to the last-known-good cache when the live query fails, and marks the result as cached", async () => {
  const { repository, service } = buildRig();
  const first = await service.getFleetHealth(undefined, { tenantId: "tenant-cache", actorId: "user-1", roles: ["platform_admin"] }, NO_FILTERS);
  assert.equal(first.servedFromCache, false);

  repository.shouldThrow = true;
  const second = await service.getFleetHealth(undefined, { tenantId: "tenant-cache", actorId: "user-1", roles: ["platform_admin"] }, NO_FILTERS);

  assert.equal(second.servedFromCache, true);
  assert.deepEqual(
    second.agents.map((a) => a.id),
    first.agents.map((a) => a.id),
  );
  await cleanup(repository, service);
});

test("with no cached snapshot available, a live query failure propagates instead of silently returning nothing", async () => {
  const { repository, service } = buildRig();
  repository.shouldThrow = true;
  await assert.rejects(() => service.getFleetHealth(undefined, { tenantId: "tenant-never-cached", actorId: "user-1", roles: ["platform_admin"] }, NO_FILTERS));
  await cleanup(repository, service);
});

test("pagination edge case: offset beyond total still returns a well-formed (empty-agents) result, not an error", async () => {
  const { repository, service } = buildRig();
  repository.rows = [];
  repository.total = 0;

  const result = await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, { offset: 500 } as ListAgentHealthQueryDto);

  assert.equal(result.agents.length, 0);
  assert.equal(result.total, 0);
  assert.equal(result.summary.totalAgents, 0);
  await cleanup(repository, service);
});

test("records a dashboard-access audit event with the applied filters", async () => {
  const { repository, service, auditService } = buildRig();
  await service.getFleetHealth(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, { framework: "crewai" } as ListAgentHealthQueryDto);

  assert.equal(auditService.events.length, 1);
  assert.equal(auditService.events[0].action, "dashboard.health_view_accessed");
  assert.equal(auditService.events[0].tenantId, "tenant-a");
  assert.deepEqual((auditService.events[0].details as any).filters.framework, "crewai");
  await cleanup(repository, service);
});

async function cleanup(_repository: FakeRepository, service: DashboardService): Promise<void> {
  await (service as any).cache.onModuleDestroy();
}
