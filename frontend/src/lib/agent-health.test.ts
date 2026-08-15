import { describe, expect, it } from "vitest";
import { applyHealthFilters, sortBySeverity } from "./agent-health";
import fixtures from "@/test/fixtures/dashboard/agent-health-fixtures.json";
import type { AgentHealthViewModel } from "@/types/dashboard";

const agents = fixtures.records as AgentHealthViewModel[];
const sampleAgent = agents[0]!;

describe("sortBySeverity", () => {
  it("orders error before degraded before active before paused before retired", () => {
    const sample: AgentHealthViewModel[] = [
      { ...sampleAgent, id: "a", status: "retired" },
      { ...sampleAgent, id: "b", status: "active" },
      { ...sampleAgent, id: "c", status: "error" },
      { ...sampleAgent, id: "d", status: "paused" },
      { ...sampleAgent, id: "e", status: "degraded" },
    ];

    const sorted = sortBySeverity(sample);
    expect(sorted.map((a) => a.status)).toEqual(["error", "degraded", "active", "paused", "retired"]);
  });

  it("does not mutate the input array", () => {
    const sample = [sampleAgent, agents[1]!];
    const copy = [...sample];
    sortBySeverity(sample);
    expect(sample).toEqual(copy);
  });

  it("works on the full 55-record fixture without throwing and preserves length", () => {
    const sorted = sortBySeverity(agents);
    expect(sorted).toHaveLength(agents.length);
  });
});

describe("applyHealthFilters", () => {
  it("with no filters, returns every agent", () => {
    expect(applyHealthFilters(agents, {})).toHaveLength(agents.length);
  });

  it("filters by framework", () => {
    const result = applyHealthFilters(agents, { framework: "langchain" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((a) => a.framework === "langchain")).toBe(true);
  });

  it("filters by health status", () => {
    const result = applyHealthFilters(agents, { status: "error" });
    expect(result.every((a) => a.status === "error")).toBe(true);
  });

  it("filters by teamId", () => {
    const teamId = sampleAgent.teamId!;
    const result = applyHealthFilters(agents, { teamId });
    expect(result.every((a) => a.teamId === teamId)).toBe(true);
    expect(result.length).toBeLessThan(agents.length);
  });

  it("combines multiple filters (AND semantics)", () => {
    const result = applyHealthFilters(agents, { framework: "crewai", status: "active" });
    expect(result.every((a) => a.framework === "crewai" && a.status === "active")).toBe(true);
  });

  it("a filter combination matching nothing returns an empty array", () => {
    const result = applyHealthFilters(agents, { teamId: "nonexistent-team" });
    expect(result).toEqual([]);
  });
});
