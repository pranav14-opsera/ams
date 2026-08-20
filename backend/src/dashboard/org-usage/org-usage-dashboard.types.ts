// WO-074: organization-wide usage tracking analytics dashboard.

export const USAGE_PERIODS = ["30d", "60d", "90d"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const USAGE_GRANULARITIES = ["daily", "weekly", "monthly"] as const;
export type UsageGranularity = (typeof USAGE_GRANULARITIES)[number];

export const CONSUMPTION_GROUP_BY = ["agent", "team", "framework"] as const;
export type ConsumptionGroupBy = (typeof CONSUMPTION_GROUP_BY)[number];

export function periodToDays(period: UsagePeriod): number {
  return { "30d": 30, "60d": 60, "90d": 90 }[period];
}

export interface CreditBalanceSummary {
  total: number;
  consumed: number;
  remaining: number;
}

export interface BurnRateSummary {
  creditsPerDay: number;
  /** ISO date string, or null when burn rate is 0 (never exhausts) or balance is already exhausted. */
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
  /** true when this response came from the last-known-good Redis cache because a live query failed/timed out. */
  servedFromCache: boolean;
}

export interface OrgUsageUpdateMessage {
  balance: CreditBalanceSummary;
  burnRate: BurnRateSummary;
  latestConsumption: ConsumptionTrendPoint | null;
}
