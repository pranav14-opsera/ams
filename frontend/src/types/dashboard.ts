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
  /** Only populated by `GET /api/v1/teams` (WO-080's own team-assignment step) — WO-075's `GET /api/v1/dashboards/usage/team/teams` selector never sets it, so every existing consumer of that endpoint's TeamRef simply sees `undefined` here, same as before this field existed. */
  memberCount?: number;
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

// WO-079: Agent Registry page — a sortable/filterable/paginated table of
// every tenant-scoped agent, distinct from the health dashboard's own
// AGENT_HEALTH_STATUSES vocabulary above. This page's own "status" column
// is the agent's LIFECYCLE status (registration/lifecycle-control state
// machine — lifecycle.service.ts), not a live health/severity reading.

export const AGENT_LIFECYCLE_STATUSES = ["connecting", "active", "paused", "retired", "decommissioned"] as const;
export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

export const AGENT_REGISTRY_SORT_FIELDS = ["name", "framework", "status", "lastSeen"] as const;
export type AgentRegistrySortField = (typeof AGENT_REGISTRY_SORT_FIELDS)[number];

export type SortOrder = "asc" | "desc";

export const AGENT_REGISTRY_PAGE_SIZES = [10, 25, 50, 100] as const;
export type AgentRegistryPageSize = (typeof AGENT_REGISTRY_PAGE_SIZES)[number];

export interface AgentRegistryTeamRef {
  id: string;
  name: string;
}

export interface AgentRegistryEntry {
  id: string;
  name: string;
  framework: AgentFramework;
  status: AgentLifecycleStatus;
  team: AgentRegistryTeamRef | null;
  lastSeen: string;
  healthScore: number | null;
  qualityScore: number | null;
}

export interface AgentRegistryFilters {
  framework?: AgentFramework[];
  status?: AgentLifecycleStatus[];
  teamId?: string;
}

export interface AgentRegistrySort {
  sortBy: AgentRegistrySortField;
  sortOrder: SortOrder;
}

export interface AgentRegistryPagination {
  page: number;
  pageSize: AgentRegistryPageSize;
  total: number;
  totalPages: number;
}

export interface AgentRegistryResult {
  data: AgentRegistryEntry[];
  pagination: AgentRegistryPagination;
}

/**
 * Wire shape published by LifecycleService onto the *existing* /ws/health
 * channel (see backend lifecycle.service.ts's own WO-079 comment) —
 * shape-tagged so useAgentHealthSocket can pick this out of the fleet
 * health snapshots (FleetHealthResult, untagged) HealthMetricsPublisherService
 * also publishes on that same channel, and ignore whichever it's not.
 */
export interface AgentStatusUpdateMessage {
  type: "agent_status_update";
  agentId: string;
  status: AgentLifecycleStatus;
  healthScore?: number | null;
  lastSeen: string;
}

// WO-080: Register New Agent multi-step wizard.

export interface CreateAgentRequest {
  name: string;
  framework: AgentFramework;
  teamId: string;
  connectionConfig: Record<string, unknown>;
  description?: string;
  frameworkVersion?: string;
}

export interface CreateAgentResponse {
  id: string;
  name: string;
  framework: string;
  status: AgentLifecycleStatus;
  teamId: string | null;
  createdAt: string;
  createdBy?: string | null;
}

export const CONNECTION_VALIDATION_STATUSES = ["pending", "success", "failed"] as const;
export type ConnectionValidationStatus = (typeof CONNECTION_VALIDATION_STATUSES)[number];

export interface ConnectionValidationInfo {
  status: ConnectionValidationStatus;
  message: string | null;
  completedAt: string | null;
}

export interface AppliedPolicies {
  rbac: string[];
  creditBudget: { amount: number; currency: string } | null;
}

export interface AgentDetail {
  id: string;
  name: string;
  framework: string;
  lifecycleStatus: AgentLifecycleStatus;
  team: AgentRegistryTeamRef | null;
  connectionValidation: ConnectionValidationInfo;
  appliedPolicies?: AppliedPolicies;
}

export interface ApiFieldError {
  field: string;
  message: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: ApiFieldError[];
  request_id?: string;
}

// WO-081: Agent Lifecycle Management UI with Bulk Operations.

/**
 * PATCH /api/v1/agents/{id}/lifecycle response — the wire shape is
 * AgentResource (agent.mapper.ts) plus `warning`, not the WO's own literal
 * `api_contracts` prose ({ id, name, previousStatus, newStatus,
 * transitionedAt, inFlightOperations }) — that prose predates the actual
 * LifecycleService/AgentsController implementation from WO-032, which this
 * WO's own README explicitly says to trust over the prose summary.
 */
export interface LifecycleTransitionResponse {
  id: string;
  name: string;
  framework: string;
  lifecycleStatus: AgentLifecycleStatus;
  team: AgentRegistryTeamRef | null;
  lastSeen: string;
  warning: string | null;
}

/** POST /api/v1/agents/bulk-lifecycle per-agent result (BulkLifecycleAgentResult on the backend) — no `agentName` on the wire, the caller already knows every selected agent's name from the registry table's own data. */
export interface BulkLifecycleAgentResult {
  agentId: string;
  status: "success" | "failed";
  previousStatus: AgentLifecycleStatus | null;
  newStatus: AgentLifecycleStatus | null;
  warning: string | null;
  error: string | null;
}

export interface BulkLifecycleResponse {
  totalCount: number;
  successCount: number;
  failureCount: number;
  results: BulkLifecycleAgentResult[];
}
