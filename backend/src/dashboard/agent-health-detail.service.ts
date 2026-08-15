import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { AgentMetricsAggregateRow } from "../adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorRepository } from "../adapters/metrics/metrics-aggregator.repository";
import { AgentStateTransitionsRepository } from "../agents/agent-state-transitions.repository";
import { AgentsRepository } from "../agents/agents.repository";
import { PlatformRoleName } from "../rbac/rbac.constants";
import { TeamMembershipRepository } from "../rbac/team-membership.repository";
import type { RequestActorContext } from "./dashboard.service";
import { granularityForRange, sinceIsoForRange, type TimeRange } from "./health-history.util";
import { computeDriftStatus, computeQualityScore, type DriftStatus } from "./quality-score.util";
import type { TraceFilters } from "../traces/trace.repository";
import { TraceService } from "../traces/trace.service";
import type { AgentExecutionTrace } from "../traces/trace.types";

export interface HealthHistoryPoint {
  bucket: string;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  errorRateAvg: number | null;
  tokenConsumptionTotal: number | null;
  toolCallSuccessRateAvg: number | null;
}

export interface AgentHealthHistoryResult {
  agentId: string;
  range: TimeRange;
  points: HealthHistoryPoint[];
  qualityScore: number | null;
  driftStatus: DriftStatus;
}

export interface LifecycleHistoryEntry {
  fromStatus: string;
  toStatus: string;
  reason: string | null;
  triggeredBy: string | null;
  occurredAt: string;
}

const TEAM_SCOPED_ROLES: readonly string[] = [PlatformRoleName.TEAM_LEAD, PlatformRoleName.AGENT_OPERATOR];

/**
 * Single-agent access scoping (distinct from DashboardService's LIST
 * scoping): @ResourceTeamParam (rbac.guard.ts) only compares a route
 * param that's already literally a team ID against the caller's
 * memberships — an agent id in the URL isn't a team id, so that
 * generic mechanism doesn't apply here. This service instead resolves
 * the AGENT's own team_id and checks it the same way DashboardService's
 * resolveTeamScope does for lists — one consistent team-scoping
 * decision, applied at the single-resource level.
 */
@Injectable()
export class AgentHealthDetailService {
  constructor(
    private readonly agentsRepository: AgentsRepository,
    private readonly metricsRepository: MetricsAggregatorRepository,
    private readonly stateTransitionsRepository: AgentStateTransitionsRepository,
    private readonly traceService: TraceService,
    private readonly teamMembershipRepository: TeamMembershipRepository,
  ) {}

  private async assertAgentAccessible(client: Pool | PoolClient | undefined, ctx: RequestActorContext, agentId: string) {
    const agent = await this.agentsRepository.findOne(client, ctx.tenantId, agentId);
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found.`);

    if (ctx.roles.includes(PlatformRoleName.PLATFORM_ADMIN)) return agent;

    const isTeamScoped = ctx.roles.some((role) => TEAM_SCOPED_ROLES.includes(role));
    if (!isTeamScoped) throw new ForbiddenException("You do not have access to this agent.");

    if (!agent.team_id || !ctx.actorId) throw new ForbiddenException("You do not have access to this agent.");
    const userTeamIds = await this.teamMembershipRepository.getUserTeamIds(ctx.tenantId, ctx.actorId);
    if (!userTeamIds.includes(agent.team_id)) throw new ForbiddenException("You do not have access to this agent.");

    return agent;
  }

  async getHealthHistory(client: Pool | PoolClient | undefined, ctx: RequestActorContext, agentId: string, range: TimeRange): Promise<AgentHealthHistoryResult> {
    await this.assertAgentAccessible(client, ctx, agentId);

    const granularity = granularityForRange(range);
    const sinceIso = sinceIsoForRange(range);
    const rows = await this.metricsRepository.findAggregatesByGranularity(granularity, ctx.tenantId, agentId, sinceIso, client);

    const points: HealthHistoryPoint[] = rows.map((row) => ({
      bucket: row.bucket.toISOString(),
      latencyP50Ms: row.latencyP50Ms,
      latencyP99Ms: row.latencyP99Ms,
      errorRateAvg: row.errorRateAvg,
      tokenConsumptionTotal: row.tokenConsumptionTotal,
      toolCallSuccessRateAvg: row.toolCallSuccessRateAvg,
    }));

    const latest = rows.at(-1) ?? null;
    return {
      agentId,
      range,
      points,
      qualityScore: latest ? computeQualityScore(latest.toolCallSuccessRateAvg, latest.errorRateAvg) : null,
      driftStatus: this.computeDrift(rows),
    };
  }

  /** "Recent" = the latest bucket; "baseline" = the average of every earlier bucket in the requested range. Both windows come from the SAME query result — no second query. */
  private computeDrift(rows: AgentMetricsAggregateRow[]): DriftStatus {
    if (rows.length < 2) return "insufficient_data";
    const recent = rows.at(-1)!;
    const baselineRows = rows.slice(0, -1);

    const avg = (values: Array<number | null>) => {
      const nonNull = values.filter((v): v is number => v !== null);
      return nonNull.length === 0 ? null : nonNull.reduce((a, b) => a + b, 0) / nonNull.length;
    };

    return computeDriftStatus({
      recentErrorRateAvg: recent.errorRateAvg,
      recentLatencyP99Ms: recent.latencyP99Ms,
      baselineErrorRateAvg: avg(baselineRows.map((r) => r.errorRateAvg)),
      baselineLatencyP99Ms: avg(baselineRows.map((r) => r.latencyP99Ms)),
    });
  }

  async getTraces(client: Pool | PoolClient | undefined, ctx: RequestActorContext, agentId: string, filters: TraceFilters): Promise<{ rows: AgentExecutionTrace[]; total: number }> {
    await this.assertAgentAccessible(client, ctx, agentId);
    return this.traceService.getAgentTraces(client, ctx.tenantId, agentId, filters);
  }

  async getLifecycleHistory(client: Pool | PoolClient | undefined, ctx: RequestActorContext, agentId: string): Promise<LifecycleHistoryEntry[]> {
    await this.assertAgentAccessible(client, ctx, agentId);
    const rows = await this.stateTransitionsRepository.findByAgentId(client, ctx.tenantId, agentId);
    return rows.map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      triggeredBy: row.triggered_by,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }
}
