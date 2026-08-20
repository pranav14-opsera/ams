import { describe, expect, it } from "vitest";
import fixtures from "./agent-registry-fixtures.json";
import { AGENT_FRAMEWORKS, AGENT_LIFECYCLE_STATUSES } from "@/types/dashboard";

/**
 * AC: "Mock data fixtures for 50+ agents across all 4 frameworks and all 5
 * lifecycle states are committed to the test fixtures directory." This
 * test is the actual, runnable proof of that fixture requirement — not
 * just a static file nobody verifies.
 */
describe("agent-registry-fixtures.json", () => {
  it("has 50 or more records", () => {
    expect(fixtures.records.length).toBeGreaterThanOrEqual(50);
  });

  it("covers all 4 documented framework values", () => {
    const frameworks = new Set(fixtures.records.map((r) => r.framework));
    for (const framework of AGENT_FRAMEWORKS) {
      expect(frameworks.has(framework)).toBe(true);
    }
  });

  it("covers all 5 documented lifecycle statuses", () => {
    const statuses = new Set(fixtures.records.map((r) => r.status));
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      expect(statuses.has(status)).toBe(true);
    }
  });

  it("every record has a unique id", () => {
    const ids = fixtures.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes at least one agent with no team assignment (edge case: unassigned agents render '—')", () => {
    expect(fixtures.records.some((r) => r.team === null)).toBe(true);
  });
});
