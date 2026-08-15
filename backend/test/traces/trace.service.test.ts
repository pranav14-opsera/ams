import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { TraceService } from "../../src/traces/trace.service";
import type { AgentExecutionTrace } from "../../src/traces/trace.types";

function makeTrace(overrides: Partial<AgentExecutionTrace> = {}): AgentExecutionTrace {
  return {
    id: "trace-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    status: "completed",
    startedAt: new Date("2026-08-16T00:00:00Z"),
    durationMs: 1200,
    steps: [
      { stepName: "retrieve_context", toolName: "vector_search", durationMs: 300, status: "success", inputSummary: "Patient SSN 123-45-6789 lookup", outputSummary: "3 documents retrieved" },
      { stepName: "generate_response", toolName: null, durationMs: 900, status: "success", inputSummary: "context + query", outputSummary: "Response generated" },
    ],
    ...overrides,
  };
}

class FakeTraceRepository {
  public lastArgs: unknown[] = [];
  public result = { rows: [makeTrace()], total: 1 };

  async findByAgentId(...args: unknown[]) {
    this.lastArgs = args;
    return this.result;
  }
}

function buildRig() {
  const repository = new FakeTraceRepository();
  const service = new TraceService(repository as any, new PhiScrubberService());
  return { repository, service };
}

test("getAgentTraces passes through tenantId/agentId/filters to the repository", async () => {
  const { repository, service } = buildRig();
  await service.getAgentTraces(undefined, "tenant-a", "agent-1", { limit: 20, offset: 0 });
  assert.deepEqual(repository.lastArgs, [undefined, "tenant-a", "agent-1", { limit: 20, offset: 0 }]);
});

test("PHI in a step's inputSummary is masked before being returned", async () => {
  const { service } = buildRig();
  const result = await service.getAgentTraces(undefined, "tenant-a", "agent-1", { limit: 20, offset: 0 });
  assert.ok(!result.rows[0].steps[0].inputSummary.includes("123-45-6789"), "an SSN-shaped value in a trace step must never reach the caller");
});

test("a step with no PHI is returned unchanged", async () => {
  const { service } = buildRig();
  const result = await service.getAgentTraces(undefined, "tenant-a", "agent-1", { limit: 20, offset: 0 });
  assert.equal(result.rows[0].steps[1].inputSummary, "context + query");
  assert.equal(result.rows[0].steps[1].outputSummary, "Response generated");
});

test("non-step fields (id, status, durationMs) pass through unmodified", async () => {
  const { service } = buildRig();
  const result = await service.getAgentTraces(undefined, "tenant-a", "agent-1", { limit: 20, offset: 0 });
  assert.equal(result.rows[0].id, "trace-1");
  assert.equal(result.rows[0].status, "completed");
  assert.equal(result.rows[0].durationMs, 1200);
});

test("total count from the repository is passed through unchanged", async () => {
  const { repository, service } = buildRig();
  repository.result = { rows: [], total: 42 };
  const result = await service.getAgentTraces(undefined, "tenant-a", "agent-1", { limit: 20, offset: 0 });
  assert.equal(result.total, 42);
});
