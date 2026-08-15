import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHealthMetricsWorker } from "./useHealthMetricsWorker";
import fixtures from "@/test/fixtures/dashboard/agent-health-fixtures.json";
import type { AgentHealthViewModel } from "@/types/dashboard";

const agents = fixtures.records as AgentHealthViewModel[];
const SEVERITY_RANK: Record<AgentHealthViewModel["status"], number> = { error: 0, degraded: 1, active: 2, paused: 3, retired: 4 };

describe("useHealthMetricsWorker", () => {
  it("falls back to main-thread computation when Worker is unavailable (jsdom has no Worker global)", async () => {
    const { result } = renderHook(() => useHealthMetricsWorker());

    const summary = await result.current.computeFleetSummary(agents.slice(0, 10));
    expect(summary.totalAgents).toBe(10);
  });

  it("main-thread sortBySeverity fallback orders by severity rank (error/degraded before active/paused/retired)", async () => {
    const { result } = renderHook(() => useHealthMetricsWorker());

    const sorted = await result.current.sortBySeverity(agents);
    for (let i = 1; i < sorted.length; i++) {
      expect(SEVERITY_RANK[sorted[i - 1]!.status]).toBeLessThanOrEqual(SEVERITY_RANK[sorted[i]!.status]);
    }
  });

  it("computeFleetSummary on an empty list returns all-zero percentages, not NaN", async () => {
    const { result } = renderHook(() => useHealthMetricsWorker());
    const summary = await result.current.computeFleetSummary([]);
    expect(summary).toEqual({ totalAgents: 0, activePct: 0, degradedPct: 0, errorPct: 0, pausedPct: 0, retiredPct: 0 });
  });

  it("does not reject when unmounted mid-flight", async () => {
    const { result, unmount } = renderHook(() => useHealthMetricsWorker());
    const pending = result.current.computeFleetSummary(agents);
    unmount();
    await expect(pending).resolves.toBeDefined();
  });
});
