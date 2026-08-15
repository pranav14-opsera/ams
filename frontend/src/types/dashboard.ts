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

export const TIME_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export interface HealthHistoryPoint {
  bucket: string;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  errorRateAvg: number | null;
  tokenConsumptionTotal: number | null;
  toolCallSuccessRateAvg: number | null;
}

export type DriftStatus = "stable" | "drifting_up" | "drifting_down" | "insufficient_data";

export interface AgentHealthHistoryResult {
  agentId: string;
  range: TimeRange;
  points: HealthHistoryPoint[];
  qualityScore: number | null;
  driftStatus: DriftStatus;
}

export const TRACE_STATUSES = ["running", "completed", "failed"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export interface TraceStep {
  stepName: string;
  toolName: string | null;
  durationMs: number;
  status: "success" | "error";
  inputSummary: string;
  outputSummary: string;
}

export interface AgentExecutionTrace {
  id: string;
  tenantId: string;
  agentId: string;
  status: TraceStatus;
  startedAt: string;
  durationMs: number | null;
  steps: TraceStep[];
}

export interface AgentTracesResult {
  rows: AgentExecutionTrace[];
  total: number;
}

export interface LifecycleHistoryEntry {
  fromStatus: string;
  toStatus: string;
  reason: string | null;
  triggeredBy: string | null;
  occurredAt: string;
}
