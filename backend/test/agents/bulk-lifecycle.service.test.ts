import { test } from "node:test";
import assert from "node:assert/strict";
import { BulkLifecycleService, MAX_BULK_BATCH_SIZE } from "../../src/agents/bulk-lifecycle.service";

function fakeAgentsRepository(agents: Array<{ id: string; team_id: string | null; framework: string; lifecycle_status: string }>) {
  return {
    findAll: async (_client: unknown, _tenantId: string, filters: any) => {
      let rows = agents;
      if (filters.teamId) rows = rows.filter((a) => a.team_id === filters.teamId);
      if (filters.framework) rows = rows.filter((a) => a.framework === filters.framework);
      if (filters.lifecycleStatus) rows = rows.filter((a) => a.lifecycle_status === filters.lifecycleStatus);
      const total = rows.length;
      return { rows: rows.slice(filters.offset, filters.offset + filters.limit), total };
    },
  } as any;
}

function fakeLifecycleService(behavior: (agentId: string) => Promise<{ lifecycleStatus: string; previousStatus: string; warning: string | null }>) {
  const calls: string[] = [];
  return {
    calls,
    transition: async (_client: unknown, _tenantId: string, _actorId: string | null, agentId: string, _targetStatus: string, _justification?: string) => {
      calls.push(agentId);
      const result = await behavior(agentId);
      return { agent: { lifecycleStatus: result.lifecycleStatus }, previousStatus: result.previousStatus, warning: result.warning };
    },
  } as any;
}

test("executes a bulk transition for every explicit agent_id and reports per-agent success", async () => {
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "paused", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);

  const result = await service.execute(undefined, "tenant-1", "actor-1", { agentIds: ["a1", "a2", "a3"], targetStatus: "paused" as any });

  assert.equal(result.totalCount, 3);
  assert.equal(result.successCount, 3);
  assert.equal(result.failureCount, 0);
  assert.deepEqual(
    result.results.map((r) => r.agentId).sort(),
    ["a1", "a2", "a3"],
  );
  assert.ok(result.results.every((r) => r.status === "success" && r.previousStatus === "active" && r.newStatus === "paused"));
});

test("isolates individual failures — a rejected agent does not block or fail the others", async () => {
  const lifecycle = fakeLifecycleService(async (agentId) => {
    if (agentId === "bad") throw Object.assign(new Error("invalid transition"), { getResponse: () => ({ message: "Cannot transition" }) });
    return { lifecycleStatus: "paused", previousStatus: "active", warning: null };
  });
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);

  const result = await service.execute(undefined, "tenant-1", "actor-1", { agentIds: ["good1", "bad", "good2"], targetStatus: "paused" as any });

  assert.equal(result.totalCount, 3);
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  const badResult = result.results.find((r) => r.agentId === "bad")!;
  assert.equal(badResult.status, "failed");
  assert.equal(badResult.error, "Cannot transition");
  assert.ok(result.results.filter((r) => r.agentId !== "bad").every((r) => r.status === "success"));
});

test("deduplicates repeated agent_ids", async () => {
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "paused", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);

  const result = await service.execute(undefined, "tenant-1", "actor-1", { agentIds: ["a1", "a1", "a1"], targetStatus: "paused" as any });
  assert.equal(result.totalCount, 1);
  assert.equal(lifecycle.calls.length, 1);
});

test("returns an empty result for an empty agent_ids array without calling the lifecycle service", async () => {
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "paused", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);

  const result = await service.execute(undefined, "tenant-1", "actor-1", { agentIds: [], targetStatus: "paused" as any });
  assert.deepEqual(result, { totalCount: 0, successCount: 0, failureCount: 0, results: [] });
  assert.equal(lifecycle.calls.length, 0);
});

test("rejects more than 100 explicit agent_ids even when called directly (bypassing the DTO's own @ArrayMaxSize)", async () => {
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "paused", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);
  const tooMany = Array.from({ length: MAX_BULK_BATCH_SIZE + 1 }, (_, i) => `agent-${i}`);

  await assert.rejects(
    () => service.execute(undefined, "tenant-1", "actor-1", { agentIds: tooMany, targetStatus: "paused" as any }),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("resolves agent_ids from filter criteria (teamId/framework/currentStatus) when agent_ids is not provided", async () => {
  const agents = [
    { id: "a1", team_id: "team-x", framework: "langchain", lifecycle_status: "active" },
    { id: "a2", team_id: "team-x", framework: "crewai", lifecycle_status: "active" },
    { id: "a3", team_id: "team-y", framework: "langchain", lifecycle_status: "active" },
  ];
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "paused", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository(agents), lifecycle);

  const result = await service.execute(undefined, "tenant-1", "actor-1", { filter: { teamId: "team-x" }, targetStatus: "paused" as any });
  assert.equal(result.totalCount, 2);
  assert.deepEqual(result.results.map((r) => r.agentId).sort(), ["a1", "a2"]);
});

test("rejects when the filter resolves more than the max batch size", async () => {
  const agents = Array.from({ length: 150 }, (_, i) => ({ id: `a${i}`, team_id: null, framework: "langchain", lifecycle_status: "active" }));
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "paused", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository(agents), lifecycle);

  await assert.rejects(
    () => service.execute(undefined, "tenant-1", "actor-1", { filter: { framework: "langchain" as any }, targetStatus: "paused" as any }),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("rejects when neither agent_ids nor filter is provided", async () => {
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "paused", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);

  await assert.rejects(
    () => service.execute(undefined, "tenant-1", "actor-1", { targetStatus: "paused" as any }),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("requires a justification for a bulk transition to Retired/Decommissioned, checked once up front", async () => {
  const lifecycle = fakeLifecycleService(async () => ({ lifecycleStatus: "retired", previousStatus: "active", warning: null }));
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);

  await assert.rejects(
    () => service.execute(undefined, "tenant-1", "actor-1", { agentIds: ["a1"], targetStatus: "retired" as any }),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
  assert.equal(lifecycle.calls.length, 0, "no per-agent transition should even be attempted without the required justification");
});

test("times out partway through and reports unresolved agents as failed with a timeout error, without blocking the whole response", async () => {
  const lifecycle = fakeLifecycleService(async (agentId) => {
    if (agentId === "slow") await new Promise((resolve) => setTimeout(resolve, 500));
    return { lifecycleStatus: "paused", previousStatus: "active", warning: null };
  });
  const service = new BulkLifecycleService(fakeAgentsRepository([]), lifecycle);

  const result = await service.execute(undefined, "tenant-1", "actor-1", { agentIds: ["fast1", "slow", "fast2"], targetStatus: "paused" as any }, 50);

  assert.equal(result.totalCount, 3);
  const slowResult = result.results.find((r) => r.agentId === "slow")!;
  assert.equal(slowResult.status, "failed");
  assert.match(slowResult.error!, /timed out/);
});
