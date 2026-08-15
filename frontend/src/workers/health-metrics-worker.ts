import * as Comlink from "comlink";
import { sortBySeverity } from "@/lib/agent-health";
import type { AgentHealthViewModel, FleetHealthSummary } from "@/types/dashboard";

/**
 * Offloads the two heaviest per-update computations (fleet summary
 * percentages, severity sort) off the main thread — at 500+ agents with
 * frequent WebSocket pushes, doing this synchronously in the render path
 * is exactly the kind of main-thread work this WO's AC calls out
 * ("keeping the main thread unblocked during large data updates").
 */
const workerApi = {
  computeFleetSummary(agents: AgentHealthViewModel[]): FleetHealthSummary {
    if (agents.length === 0) return { totalAgents: 0, activePct: 0, degradedPct: 0, errorPct: 0, pausedPct: 0, retiredPct: 0 };

    const counts = { active: 0, degraded: 0, error: 0, paused: 0, retired: 0 };
    for (const agent of agents) counts[agent.status]++;
    const pct = (n: number) => Math.round((n / agents.length) * 1000) / 10;

    return {
      totalAgents: agents.length,
      activePct: pct(counts.active),
      degradedPct: pct(counts.degraded),
      errorPct: pct(counts.error),
      pausedPct: pct(counts.paused),
      retiredPct: pct(counts.retired),
    };
  },

  sortBySeverity(agents: AgentHealthViewModel[]): AgentHealthViewModel[] {
    return sortBySeverity(agents);
  },
};

export type HealthMetricsWorkerApi = typeof workerApi;

Comlink.expose(workerApi);
