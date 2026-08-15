import type { AgentHealthFilters, AgentHealthViewModel } from "@/types/dashboard";

/** AC: agents with degraded/error status are sorted to the top by default. */
const SEVERITY_RANK: Record<AgentHealthViewModel["status"], number> = {
  error: 0,
  degraded: 1,
  active: 2,
  paused: 3,
  retired: 4,
};

export function sortBySeverity(agents: AgentHealthViewModel[]): AgentHealthViewModel[] {
  return [...agents].sort((a, b) => SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status]);
}

/** Client-side filtering applied to a WebSocket-pushed full-fleet snapshot, mirroring the server's own filter semantics (dashboard.service.ts) so the displayed list stays consistent whether it came from the REST fetch or a live push. */
export function applyHealthFilters(agents: AgentHealthViewModel[], filters: AgentHealthFilters): AgentHealthViewModel[] {
  return agents.filter((agent) => {
    if (filters.teamId && agent.teamId !== filters.teamId) return false;
    if (filters.framework && agent.framework !== filters.framework) return false;
    if (filters.status && agent.status !== filters.status) return false;
    return true;
  });
}
