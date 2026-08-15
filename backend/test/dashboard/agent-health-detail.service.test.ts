import { test } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AgentHealthDetailService } from "../../src/dashboard/agent-health-detail.service";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return { id: "agent-1", tenant_id: "tenant-a", team_id: "team-1", name: "Agent One", framework: "langchain", lifecycle_status: "active", ...overrides };
}

function makeAggregateRow(overrides: Record<string, unknown> = {}) {
  return { bucket: new Date("2026-08-16T00:00:00Z"), latencyP50Ms: 100, latencyP99Ms: 200, errorRateAvg: 0, tokenConsumptionTotal: 10, toolCallSuccessRateAvg: 1, ...overrides };
}

class FakeAgentsRepository {
  public agent: ReturnType<typeof makeAgent> | null = makeAgent();
  async findOne() {
    return this.agent;
  }
}

class FakeMetricsRepository {
  public rows = [makeAggregateRow()];
  async findAggregatesByGranularity() {
    return this.rows;
  }
}

class FakeStateTransitionsRepository {
  public rows: any[] = [];
  async findByAgentId() {
    return this.rows;
  }
}

class FakeTraceService {
  public result = { rows: [], total: 0 };
  public lastArgs: unknown[] = [];
  async getAgentTraces(...args: unknown[]) {
    this.lastArgs = args;
    return this.result;
  }
}

class FakeTeamMembershipRepository {
  public teamIdsByUser = new Map<string, string[]>();
  async getUserTeamIds(_tenantId: string, userId: string) {
    return this.teamIdsByUser.get(userId) ?? [];
  }
}

function buildRig() {
  const agentsRepository = new FakeAgentsRepository();
  const metricsRepository = new FakeMetricsRepository();
  const stateTransitionsRepository = new FakeStateTransitionsRepository();
  const traceService = new FakeTraceService();
  const teamMembershipRepository = new FakeTeamMembershipRepository();
  const service = new AgentHealthDetailService(agentsRepository as any, metricsRepository as any, stateTransitionsRepository as any, traceService as any, teamMembershipRepository as any);
  return { agentsRepository, metricsRepository, stateTransitionsRepository, traceService, teamMembershipRepository, service };
}

test("a nonexistent agent (findOne returns null) is a 404, regardless of role", async () => {
  const { agentsRepository, service } = buildRig();
  agentsRepository.agent = null;
  await assert.rejects(() => service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, "agent-1", "24h"), NotFoundException);
});

test("platform_admin can access any agent, regardless of team", async () => {
  const { service } = buildRig();
  const result = await service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, "agent-1", "24h");
  assert.equal(result.agentId, "agent-1");
});

test("a team_lead whose team matches the agent's team is granted access", async () => {
  const { teamMembershipRepository, service } = buildRig();
  teamMembershipRepository.teamIdsByUser.set("user-2", ["team-1"]);
  const result = await service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-2", roles: ["team_lead"] }, "agent-1", "24h");
  assert.equal(result.agentId, "agent-1");
});

test("a team_lead whose team does NOT match the agent's team is denied (403)", async () => {
  const { teamMembershipRepository, service } = buildRig();
  teamMembershipRepository.teamIdsByUser.set("user-2", ["team-9"]);
  await assert.rejects(() => service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-2", roles: ["team_lead"] }, "agent-1", "24h"), ForbiddenException);
});

test("agent_operator is scoped the same way as team_lead", async () => {
  const { teamMembershipRepository, service } = buildRig();
  teamMembershipRepository.teamIdsByUser.set("user-3", ["team-9"]);
  await assert.rejects(() => service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-3", roles: ["agent_operator"] }, "agent-1", "24h"), ForbiddenException);
});

test("a role with no team-scoped or admin role at all is denied", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-4", roles: ["finance_manager"] }, "agent-1", "24h"), ForbiddenException);
});

test("an agent with no team_id (unassigned) denies every team-scoped role, even one with matching-looking access", async () => {
  const { agentsRepository, teamMembershipRepository, service } = buildRig();
  agentsRepository.agent = makeAgent({ team_id: null });
  teamMembershipRepository.teamIdsByUser.set("user-2", ["team-1"]);
  await assert.rejects(() => service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-2", roles: ["team_lead"] }, "agent-1", "24h"), ForbiddenException);
});

test("getHealthHistory computes a quality score and drift status from the returned points", async () => {
  const { metricsRepository, service } = buildRig();
  metricsRepository.rows = [makeAggregateRow({ errorRateAvg: 0.01 }), makeAggregateRow({ errorRateAvg: 0.5 })];
  const result = await service.getHealthHistory(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, "agent-1", "24h");
  assert.equal(result.driftStatus, "drifting_up");
  assert.ok(result.qualityScore !== null);
});

test("getTraces enforces the same access check before delegating to TraceService", async () => {
  const { teamMembershipRepository, traceService, service } = buildRig();
  teamMembershipRepository.teamIdsByUser.set("user-2", ["team-9"]);
  await assert.rejects(() => service.getTraces(undefined, { tenantId: "tenant-a", actorId: "user-2", roles: ["team_lead"] }, "agent-1", { limit: 20, offset: 0 }), ForbiddenException);

  await service.getTraces(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, "agent-1", { limit: 20, offset: 0 });
  assert.deepEqual(traceService.lastArgs, [undefined, "tenant-a", "agent-1", { limit: 20, offset: 0 }]);
});

test("getLifecycleHistory enforces the same access check and maps rows to the response shape", async () => {
  const { stateTransitionsRepository, service } = buildRig();
  stateTransitionsRepository.rows = [
    { from_status: "connecting", to_status: "active", reason: "initial activation", triggered_by: "user-1", occurred_at: new Date("2026-08-01T00:00:00Z") },
  ];

  const result = await service.getLifecycleHistory(undefined, { tenantId: "tenant-a", actorId: "user-1", roles: ["platform_admin"] }, "agent-1");
  assert.deepEqual(result, [{ fromStatus: "connecting", toStatus: "active", reason: "initial activation", triggeredBy: "user-1", occurredAt: "2026-08-01T00:00:00.000Z" }]);
});
