// WO-075: team-scoped usage analytics dashboard — reuses WO-074's org-wide
// dashboard patterns (balance/burn-rate shape, cache-fallback service
// shape, WebSocket push infra) but adds team scoping and the richer
// filter set this WO's own api_contracts call for.

// This WO's own api_contracts literally add "7d" to WO-074's 30/60/90-day
// period set — a separate union/const rather than widening
// org-usage-dashboard.types.ts's USAGE_PERIODS, since the org dashboard's
// own AC never asked for a 7-day window and widening a shared type would
// let it silently appear there too.
export const TEAM_USAGE_PERIODS = ["7d", "30d", "60d", "90d"] as const;
export type TeamUsagePeriod = (typeof TEAM_USAGE_PERIODS)[number];

export function teamPeriodToDays(period: TeamUsagePeriod): number {
  return { "7d": 7, "30d": 30, "60d": 60, "90d": 90 }[period];
}

// api_contracts: "granularity=daily|weekly" — no "monthly" option for the
// team dashboard (unlike the org dashboard's own three-way granularity).
export const TEAM_USAGE_GRANULARITIES = ["daily", "weekly"] as const;
export type TeamUsageGranularity = (typeof TEAM_USAGE_GRANULARITIES)[number];

// api_contracts: "frameworks=langchain|crewai|autogen|rest" — this WO's
// own wire vocabulary uses "rest", but `agents.framework` (migration 004)
// stores "generic_rest" (see AGENT_FRAMEWORKS in
// agents/dto/create-agent.dto.ts). Translated at the repository boundary
// (teamUsageFrameworkToDb/dbFrameworkToTeamUsage below) rather than
// changing the stored column value platform-wide.
export const TEAM_USAGE_FRAMEWORKS = ["langchain", "crewai", "autogen", "rest"] as const;
export type TeamUsageFramework = (typeof TEAM_USAGE_FRAMEWORKS)[number];

const FRAMEWORK_WIRE_TO_DB: Record<TeamUsageFramework, string> = {
  langchain: "langchain",
  crewai: "crewai",
  autogen: "autogen",
  rest: "generic_rest",
};

const FRAMEWORK_DB_TO_WIRE: Record<string, string> = {
  langchain: "langchain",
  crewai: "crewai",
  autogen: "autogen",
  generic_rest: "rest",
};

export function teamUsageFrameworksToDb(frameworks: TeamUsageFramework[]): string[] {
  return frameworks.map((f) => FRAMEWORK_WIRE_TO_DB[f]);
}

export function dbFrameworkToTeamUsageWire(framework: string): string {
  return FRAMEWORK_DB_TO_WIRE[framework] ?? framework;
}

export interface TeamRef {
  id: string;
  name: string;
}

export interface TeamBalanceSummary {
  allocated: number;
  consumed: number;
  remaining: number;
  /** null when the team has no budget allocation at all for the current period (edge case: never-allocated team) — rendered by the frontend as "Not budgeted" rather than a misleading 0%. */
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
  /** true when creditsConsumed exceeds 2x the mean consumption across every agent in this comparison set (AC 4). */
  isAboveThreshold: boolean;
}

export interface TeamUsageFiltersApplied {
  period: TeamUsagePeriod;
  granularity: TeamUsageGranularity;
  agents?: string[];
  actionTypes?: string[];
  frameworks?: TeamUsageFramework[];
}

export interface TeamUsageFilters {
  agentIds?: string[];
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
  /** true when this response came from the last-known-good Redis cache because a live query failed/timed out (same fallback posture as OrgUsageSummary). */
  servedFromCache: boolean;
}

export interface TeamUsageUpdateMessage {
  teamId: string;
  balance: TeamBalanceSummary;
  burnRate: TeamBurnRateSummary;
  latestConsumption: TeamConsumptionTrendPoint | null;
}
