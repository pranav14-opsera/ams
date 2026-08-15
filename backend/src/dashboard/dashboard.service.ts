import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../classification/data-classification.enum";
import { PhiScrubberService } from "../phi-scrubber/phi-scrubber.service";
import { PlatformRoleName } from "../rbac/rbac.constants";
import { TeamMembershipRepository } from "../rbac/team-membership.repository";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import type { ListAgentHealthQueryDto } from "./dto/list-agent-health-query.dto";
import { HealthCacheService } from "./health-cache.service";
import { HealthDashboardRepository, type AgentHealthRow } from "./health-dashboard.repository";
import { computeHealthStatus, type AgentHealthStatus } from "./health-status.util";

export interface AgentHealthViewModel {
  id: string;
  teamId: string | null;
  name: string;
  framework: AgentHealthRow["framework"];
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
  /** true when this response came from the last-known-good Redis cache because the live query failed/timed out. */
  servedFromCache: boolean;
}

export interface RequestActorContext {
  tenantId: string;
  actorId: string | null;
  roles: string[];
}

const TEAM_SCOPED_ROLES: readonly string[] = [PlatformRoleName.TEAM_LEAD, PlatformRoleName.AGENT_OPERATOR];

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly repository: HealthDashboardRepository,
    private readonly teamMembershipRepository: TeamMembershipRepository,
    private readonly cache: HealthCacheService,
    private readonly phiScrubber: PhiScrubberService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  /**
   * Server-side role scoping (AC: "enforced server-side"): platform_admin
   * sees every agent in the tenant; team_lead and agent_operator are both
   * scoped to the caller's own team memberships (this codebase has no
   * separate "assigned to me individually" table for agent_operator today
   * — team membership is the finest-grained real scoping mechanism that
   * exists, so both team-scoped roles share it here rather than inventing
   * an unbacked "assignment" concept). Any other/no role sees nothing —
   * deny by default, matching RbacGuard's own posture — though in
   * practice RequirePermission(AGENT_READ) already blocks the route
   * entirely before this runs for a caller with no grant at all.
   */
  private async resolveTeamScope(ctx: RequestActorContext): Promise<string[] | null> {
    if (ctx.roles.includes(PlatformRoleName.PLATFORM_ADMIN)) return null;
    if (!ctx.roles.some((role) => TEAM_SCOPED_ROLES.includes(role))) return [];
    if (!ctx.actorId) return [];
    return this.teamMembershipRepository.getUserTeamIds(ctx.tenantId, ctx.actorId);
  }

  async getFleetHealth(client: Pool | PoolClient | undefined, ctx: RequestActorContext, query: ListAgentHealthQueryDto): Promise<FleetHealthResult> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const servedFromCache = false;
    let rows: AgentHealthRow[];
    let total: number;

    try {
      const teamIds = await this.resolveTeamScope(ctx);
      const result = await this.repository.findFleetHealth(client, ctx.tenantId, {
        teamIds,
        framework: query.framework,
        lifecycleStatus: query.lifecycleStatus,
        limit,
        offset,
      });
      rows = result.rows;
      total = result.total;
    } catch (err) {
      this.logger.warn(`live fleet health query failed for tenant ${ctx.tenantId}, falling back to cached snapshot: ${err instanceof Error ? err.message : err}`);
      const cached = (await this.cache.get(ctx.tenantId)) as FleetHealthResult | null;
      if (!cached) throw err;
      return { ...cached, servedFromCache: true };
    }

    const viewModels = rows
      .map((row) => this.toViewModel(row))
      .filter((agent) => !query.status || agent.status === query.status);

    const result: FleetHealthResult = {
      summary: this.computeSummary(viewModels, total),
      agents: this.scrub(viewModels),
      total,
      limit,
      offset,
      servedFromCache,
    };

    if (offset === 0 && !query.status) {
      // Only cache the unfiltered first page — the fallback snapshot is a
      // "something is better than nothing" default view, not expected to
      // match every possible filter combination a caller might request.
      await this.cache.set(ctx.tenantId, result);
    }

    this.recordAccessAuditEvent(ctx, query);
    return result;
  }

  private toViewModel(row: AgentHealthRow): AgentHealthViewModel {
    const metrics = row.metricsBucket ? { errorRateAvg: row.errorRateAvg, latencyP99Ms: row.latencyP99Ms } : null;
    return {
      id: row.id,
      teamId: row.teamId,
      name: row.name,
      framework: row.framework,
      status: computeHealthStatus(row.lifecycleStatus, metrics),
      latencyP50Ms: row.latencyP50Ms,
      latencyP99Ms: row.latencyP99Ms,
      errorRateAvg: row.errorRateAvg,
      tokenConsumptionTotal: row.tokenConsumptionTotal,
      toolCallSuccessRateAvg: row.toolCallSuccessRateAvg,
      metricsBucket: row.metricsBucket ? row.metricsBucket.toISOString() : null,
    };
  }

  private computeSummary(agents: AgentHealthViewModel[], total: number): FleetHealthSummary {
    if (total === 0) return { totalAgents: 0, activePct: 0, degradedPct: 0, errorPct: 0, pausedPct: 0, retiredPct: 0 };

    const counts = { active: 0, degraded: 0, error: 0, paused: 0, retired: 0 };
    for (const agent of agents) counts[agent.status]++;
    const pct = (n: number) => Math.round((n / agents.length) * 1000) / 10;

    return {
      totalAgents: total,
      activePct: pct(counts.active),
      degradedPct: pct(counts.degraded),
      errorPct: pct(counts.error),
      pausedPct: pct(counts.paused),
      retiredPct: pct(counts.retired),
    };
  }

  /**
   * PHI scrub ONLY the `name` field — free text an operator chose, the
   * one realistic PHI risk surface in this payload — before this ever
   * reaches a REST response or a WebSocket push. Deliberately NOT run
   * over the whole view model: `id`/`teamId` are UUIDs and
   * `metricsBucket` is an ISO timestamp, both plain strings that
   * scrubEmbeddedText's substring-level masking would otherwise mangle
   * (found via testing — a naive "scrub every string field" pass
   * corrupted every agent's id). tenantSettings is omitted (default
   * detection patterns only): fetching per-tenant PHI pattern overrides
   * here would pull in the full tenant-settings dependency chain for a
   * payload that is, by construction, aggregate numeric health metrics
   * plus one operator-chosen label — out of this WO's scope.
   */
  private scrub(agents: AgentHealthViewModel[]): AgentHealthViewModel[] {
    return agents.map((agent) => ({ ...agent, name: this.phiScrubber.scrubText(agent.name, null) }));
  }

  private recordAccessAuditEvent(ctx: RequestActorContext, query: ListAgentHealthQueryDto): void {
    this.auditService
      .recordEvent({
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: "dashboard.health_view_accessed",
        resourceType: "agent_health_dashboard",
        resourceId: ctx.tenantId,
        details: { filters: { teamId: query.teamId, framework: query.framework, lifecycleStatus: query.lifecycleStatus, status: query.status } },
        dataClassification: DataClassification.INTERNAL,
      })
      .catch((err) => this.logger.warn(`failed to record dashboard access audit event: ${err instanceof Error ? err.message : err}`));
  }
}
