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

// WO-074: organization-wide usage tracking analytics dashboard.

export const USAGE_PERIODS = ["30d", "60d", "90d"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const USAGE_GRANULARITIES = ["daily", "weekly", "monthly"] as const;
export type UsageGranularity = (typeof USAGE_GRANULARITIES)[number];

export interface CreditBalanceSummary {
  total: number;
  consumed: number;
  remaining: number;
}

export interface BurnRateSummary {
  creditsPerDay: number;
  projectedExhaustionDate: string | null;
}

export interface ConsumptionTrendPoint {
  date: string;
  credits: number;
}

export interface AgentConsumptionEntry {
  agentId: string;
  agentName: string;
  framework: string;
  creditsConsumed: number;
}

export interface OrgUsageSummary {
  balance: CreditBalanceSummary;
  burnRate: BurnRateSummary;
  activeAgents: number;
  consumptionTrend: ConsumptionTrendPoint[];
  agentBreakdown: AgentConsumptionEntry[];
  servedFromCache: boolean;
}

export interface OrgUsageUpdateMessage {
  balance: CreditBalanceSummary;
  burnRate: BurnRateSummary;
  latestConsumption: ConsumptionTrendPoint | null;
}

// WO-075: team-scoped usage analytics dashboard.

export const TEAM_USAGE_PERIODS = ["7d", "30d", "60d", "90d"] as const;
export type TeamUsagePeriod = (typeof TEAM_USAGE_PERIODS)[number];

export const TEAM_USAGE_GRANULARITIES = ["daily", "weekly"] as const;
export type TeamUsageGranularity = (typeof TEAM_USAGE_GRANULARITIES)[number];

/** Backend wire vocabulary (TeamUsageFramework) — note "rest", not this codebase's usual "generic_rest" DB value; the backend translates at its own repository boundary. */
export const TEAM_USAGE_FRAMEWORKS = ["langchain", "crewai", "autogen", "rest"] as const;
export type TeamUsageFramework = (typeof TEAM_USAGE_FRAMEWORKS)[number];

export interface TeamRef {
  id: string;
  name: string;
}

export interface TeamBalanceSummary {
  allocated: number;
  consumed: number;
  remaining: number;
  utilizationPct: number | null;
}

export interface TeamBurnRateSummary {
  creditsPerDay: number;
}

export interface TeamConsumptionTrendPoint {
  date: string;
  credits: number;
}

export interface TeamAgentComparisonEntry {
  agentId: string;
  agentName: string;
  framework: string;
  creditsConsumed: number;
  isAboveThreshold: boolean;
}

export interface TeamUsageFilters {
  agentIds?: string[];
  actionTypes?: string[];
  frameworks?: TeamUsageFramework[];
}

export interface TeamUsageFiltersApplied {
  period: TeamUsagePeriod;
  granularity: TeamUsageGranularity;
  agents?: string[];
  actionTypes?: string[];
  frameworks?: TeamUsageFramework[];
}

export interface TeamUsageSummary {
  team: TeamRef;
  balance: TeamBalanceSummary;
  burnRate: TeamBurnRateSummary;
  agentCount: number;
  consumptionTrend: TeamConsumptionTrendPoint[];
  agentComparison: TeamAgentComparisonEntry[];
  filtersApplied: TeamUsageFiltersApplied;
  servedFromCache: boolean;
}

export interface TeamUsageUpdateMessage {
  teamId: string;
  balance: TeamBalanceSummary;
  burnRate: TeamBurnRateSummary;
  latestConsumption: TeamConsumptionTrendPoint | null;
}
