export const AGENT_HEALTH_STATUSES = ["active", "paused", "degraded", "error", "retired"] as const;
export type AgentHealthStatus = (typeof AGENT_HEALTH_STATUSES)[number];

export const AGENT_FRAMEWORKS = ["langchain", "crewai", "autogen", "generic_rest"] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

export interface AgentHealthViewModel {
  id: string;
  teamId: string | null;
  name: string;
  framework: AgentFramework;
  status: AgentHealthStatus;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  errorRateAvg: number | null;
  tokenConsumptionTotal: number | null;
  toolCallSuccessRateAvg: number | null;
  metricsBucket: string | null;
}

export interface FleetHealthSummary {
  totalAgents: number;
  activePct: number;
  degradedPct: number;
  errorPct: number;
  pausedPct: number;
  retiredPct: number;
}

export interface FleetHealthResult {
  summary: FleetHealthSummary;
  agents: AgentHealthViewModel[];
  total: number;
  limit: number;
  offset: number;
  servedFromCache: boolean;
}

export interface AgentHealthFilters {
  teamId?: string;
  framework?: AgentFramework;
  status?: AgentHealthStatus;
}
