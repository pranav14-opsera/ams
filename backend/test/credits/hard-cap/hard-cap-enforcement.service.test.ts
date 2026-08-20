import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import { HardCapEnforcementService } from "../../../src/credits/hard-cap/hard-cap-enforcement.service";

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-1",
    allocatedCredits: 1000,
    consumedCredits: 500,
    remainingCredits: 500,
    consumptionPercentage: 50,
    alertThreshold75: true,
    alertThreshold90: true,
    hardCap: 900,
    effectiveMonth: 8,
    effectiveYear: 2026,
    projectedExhaustionDate: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return { id, tenant_id: "tenant-a", team_id: "team-1", lifecycle_status: "active", version: 1, ...overrides };
}

class FakeBudgetService {
  public summaries = new Map<string, ReturnType<typeof makeSummary>>();
  async getTeamBudget(_client: unknown, _tenantId: string, teamId: string) {
    const summary = this.summaries.get(teamId);
    if (!summary) throw new NotFoundException("no budget");
    return summary;
  }
}

class FakeAgentsRepository {
  public agents = new Map<string, ReturnType<typeof makeAgent>>();
  async findAll(_client: unknown, _tenantId: string, filters: { teamId?: string; lifecycleStatus?: string }) {
    const rows = [...this.agents.values()].filter((a) => (!filters.teamId || a.team_id === filters.teamId) && (!filters.lifecycleStatus || a.lifecycle_status === filters.lifecycleStatus));
    return { rows, total: rows.length };
  }
  async findOne(_client: unknown, _tenantId: string, id: string) {
    return this.agents.get(id) ?? null;
  }
}

class FakeLifecycleService {
  public transitions: Array<{ agentId: string; targetStatus: string; justification: string | undefined }> = [];
  private readonly agentsRepository: FakeAgentsRepository;
  constructor(agentsRepository: FakeAgentsRepository) {
    this.agentsRepository = agentsRepository;
  }
  async transition(_client: unknown, _tenantId: string, _actorId: string | null, agentId: string, targetStatus: string, justification?: string) {
    this.transitions.push({ agentId, targetStatus, justification });
    const agent = this.agentsRepository.agents.get(agentId);
    if (agent) agent.lifecycle_status = targetStatus;
    return { agent, previousStatus: "active", warning: null };
  }
}

class FakePauseStateRepository {
  public paused = new Map<string, Array<{ id: string; tenantId: string; teamId: string; agentId: string; pausedAt: Date }>>();
  async recordPause(_client: unknown, tenantId: string, teamId: string, agentId: string) {
    const rows = this.paused.get(teamId) ?? [];
    if (!rows.some((r) => r.agentId === agentId)) rows.push({ id: `pause-${rows.length + 1}`, tenantId, teamId, agentId, pausedAt: new Date() });
    this.paused.set(teamId, rows);
  }
  async clearPause(_client: unknown, _tenantId: string, agentId: string) {
    for (const [teamId, rows] of this.paused) {
      this.paused.set(teamId, rows.filter((r) => r.agentId !== agentId));
    }
  }
  async findPausedForTeam(_client: unknown, _tenantId: string, teamId: string) {
    return this.paused.get(teamId) ?? [];
  }
}

class FakeAlertEventRepository {
  public created: unknown[] = [];
  async create(_client: unknown, tenantId: string, agentId: string, fields: Record<string, unknown>) {
    const event = { id: `alert-${this.created.length + 1}`, tenantId, agentId, ...fields };
    this.created.push(event);
    return event;
  }
}

class FakeAlertDeliveryService {
  public delivered: unknown[] = [];
  async deliver(event: unknown) {
    this.delivered.push(event);
  }
}

function buildRig() {
  const budgetService = new FakeBudgetService();
  const agentsRepository = new FakeAgentsRepository();
  const lifecycleService = new FakeLifecycleService(agentsRepository);
  const pauseStateRepository = new FakePauseStateRepository();
  const alertEventRepository = new FakeAlertEventRepository();
  const alertDeliveryService = new FakeAlertDeliveryService();
  const service = new HardCapEnforcementService(pauseStateRepository as any, budgetService as any, agentsRepository as any, lifecycleService as any, alertEventRepository as any, alertDeliveryService as any);
  return { budgetService, agentsRepository, lifecycleService, pauseStateRepository, alertEventRepository, alertDeliveryService, service };
}

test("a team below its hard cap is left alone — no pauses", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 500, hardCap: 900 }));

  const outcome = await service.enforceIfBreached(undefined, "tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.pausedAgentIds, []);
});

test("a team with no hard cap configured (null) is never paused, no matter the consumption", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 5000, hardCap: null }));

  const outcome = await service.enforceIfBreached(undefined, "tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.pausedAgentIds, []);
});

test("a team with no budget configured for this period is skipped without throwing", async () => {
  const { service } = buildRig();
  const outcome = await service.enforceIfBreached(undefined, "tenant-a", "no-such-team", 8, 2026);
  assert.deepEqual(outcome.pausedAgentIds, []);
});

test("a team that reaches (exactly equals) its hard cap pauses every active agent, tracks each in pause state, and raises a critical alert per agent", async () => {
  const { budgetService, agentsRepository, lifecycleService, pauseStateRepository, alertEventRepository, alertDeliveryService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 900, hardCap: 900 }));
  agentsRepository.agents.set("agent-1", makeAgent("agent-1"));
  agentsRepository.agents.set("agent-2", makeAgent("agent-2"));
  agentsRepository.agents.set("agent-3", makeAgent("agent-3", { lifecycle_status: "paused" })); // already paused — findAll(lifecycleStatus:'active') excludes it

  const outcome = await service.enforceIfBreached(undefined, "tenant-a", "team-1", 8, 2026);

  assert.deepEqual(outcome.pausedAgentIds.sort(), ["agent-1", "agent-2"]);
  assert.equal(lifecycleService.transitions.length, 2);
  assert.ok(lifecycleService.transitions.every((t) => t.targetStatus === "paused"));
  assert.equal((await pauseStateRepository.findPausedForTeam(undefined, "tenant-a", "team-1")).length, 2);
  assert.equal(alertEventRepository.created.length, 2);
  assert.ok(alertEventRepository.created.every((e: any) => e.severity === "critical" && e.metricName === "credit_hard_cap_reached"));
  assert.equal(alertDeliveryService.delivered.length, 2);
});

test("a team that EXCEEDS its hard cap (not just reaches it) also pauses every active agent", async () => {
  const { budgetService, agentsRepository, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 950, hardCap: 900 }));
  agentsRepository.agents.set("agent-1", makeAgent("agent-1"));

  const outcome = await service.enforceIfBreached(undefined, "tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.pausedAgentIds, ["agent-1"]);
});

test("a single agent's pause failure doesn't stop the rest of the team's agents from being paused", async () => {
  const { budgetService, agentsRepository, lifecycleService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 900, hardCap: 900 }));
  agentsRepository.agents.set("agent-1", makeAgent("agent-1"));
  agentsRepository.agents.set("agent-2", makeAgent("agent-2"));

  const originalTransition = lifecycleService.transition.bind(lifecycleService);
  lifecycleService.transition = async (client, tenantId, actorId, agentId, targetStatus, justification) => {
    if (agentId === "agent-1") throw new Error("simulated transition failure");
    return originalTransition(client, tenantId, actorId, agentId, targetStatus, justification);
  };

  const outcome = await service.enforceIfBreached(undefined, "tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.pausedAgentIds, ["agent-2"]);
});

test("without the optional alert services wired at all, pausing still works (zero blast radius)", async () => {
  const budgetService = new FakeBudgetService();
  const agentsRepository = new FakeAgentsRepository();
  const lifecycleService = new FakeLifecycleService(agentsRepository);
  const pauseStateRepository = new FakePauseStateRepository();
  const service = new HardCapEnforcementService(pauseStateRepository as any, budgetService as any, agentsRepository as any, lifecycleService as any);
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 900, hardCap: 900 }));
  agentsRepository.agents.set("agent-1", makeAgent("agent-1"));

  const outcome = await service.enforceIfBreached(undefined, "tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.pausedAgentIds, ["agent-1"]);
});

test("resumeIfBelowCap is a no-op when nothing is currently auto-paused for the team", async () => {
  const { budgetService, service } = buildRig();
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 100, hardCap: 900 }));

  const outcome = await service.resumeIfBelowCap("tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.resumedAgentIds, []);
});

test("resumeIfBelowCap resumes every auto-paused agent once consumption drops back below the (possibly raised) hard cap", async () => {
  const { budgetService, agentsRepository, lifecycleService, pauseStateRepository, service } = buildRig();
  agentsRepository.agents.set("agent-1", makeAgent("agent-1", { lifecycle_status: "paused" }));
  agentsRepository.agents.set("agent-2", makeAgent("agent-2", { lifecycle_status: "paused" }));
  await pauseStateRepository.recordPause(undefined, "tenant-a", "team-1", "agent-1");
  await pauseStateRepository.recordPause(undefined, "tenant-a", "team-1", "agent-2");
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 500, hardCap: 2000 })); // cap raised, consumption now well below it

  const outcome = await service.resumeIfBelowCap("tenant-a", "team-1", 8, 2026);

  assert.deepEqual(outcome.resumedAgentIds.sort(), ["agent-1", "agent-2"]);
  assert.equal(agentsRepository.agents.get("agent-1")!.lifecycle_status, "active");
  assert.equal((await pauseStateRepository.findPausedForTeam(undefined, "tenant-a", "team-1")).length, 0);
  assert.ok(lifecycleService.transitions.some((t) => t.agentId === "agent-1" && t.targetStatus === "active"));
});

test("resumeIfBelowCap does nothing while consumption is still at or above the (still-current) hard cap", async () => {
  const { budgetService, agentsRepository, pauseStateRepository, service } = buildRig();
  agentsRepository.agents.set("agent-1", makeAgent("agent-1", { lifecycle_status: "paused" }));
  await pauseStateRepository.recordPause(undefined, "tenant-a", "team-1", "agent-1");
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 900, hardCap: 900 }));

  const outcome = await service.resumeIfBelowCap("tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.resumedAgentIds, []);
  assert.equal(agentsRepository.agents.get("agent-1")!.lifecycle_status, "paused");
});

test("resumeIfBelowCap never touches an agent that was manually retired/decommissioned while auto-paused — it just stops tracking it", async () => {
  const { budgetService, agentsRepository, lifecycleService, pauseStateRepository, service } = buildRig();
  agentsRepository.agents.set("agent-1", makeAgent("agent-1", { lifecycle_status: "retired" })); // an operator manually retired it after the auto-pause
  await pauseStateRepository.recordPause(undefined, "tenant-a", "team-1", "agent-1");
  budgetService.summaries.set("team-1", makeSummary({ consumedCredits: 100, hardCap: 900 }));

  const outcome = await service.resumeIfBelowCap("tenant-a", "team-1", 8, 2026);
  assert.deepEqual(outcome.resumedAgentIds, []);
  assert.equal(lifecycleService.transitions.length, 0, "must never transition a manually-retired agent back to active");
  assert.equal((await pauseStateRepository.findPausedForTeam(undefined, "tenant-a", "team-1")).length, 0, "the stale pause-state row must still be cleared");
  assert.equal(agentsRepository.agents.get("agent-1")!.lifecycle_status, "retired");
});
