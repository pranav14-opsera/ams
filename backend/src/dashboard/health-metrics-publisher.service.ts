import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { RedisPubSubService } from "../websocket-gateway/redis-pubsub.service";
import { DashboardService, type RequestActorContext } from "./dashboard.service";
import { HealthDashboardRepository } from "./health-dashboard.repository";
import { ListAgentHealthQueryDto } from "./dto/list-agent-health-query.dto";

const NO_FILTERS: ListAgentHealthQueryDto = new ListAgentHealthQueryDto();

/**
 * Bridges the health-metrics read path to HealthGateway's "health"
 * channel. In production this runs on an interval (matching the
 * dashboard's own 30-second freshness target) after each refresh of the
 * agent_health_5s_agg materialized view; not wired to a live scheduler in
 * this sandbox (same class of gap as HealthDashboardRepository's own
 * refreshHealthAggregate). publishUpdate is exposed directly for
 * synthetic-event integration tests to call after inserting telemetry, so
 * the real refresh -> query -> PHI-scrub -> publish chain is genuinely
 * exercised end-to-end rather than stubbed.
 */
@Injectable()
export class HealthMetricsPublisherService {
  private readonly logger = new Logger(HealthMetricsPublisherService.name);

  constructor(
    private readonly repository: HealthDashboardRepository,
    private readonly dashboardService: DashboardService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  async publishUpdate(client: Pool | PoolClient | undefined, tenantId: string): Promise<void> {
    await this.repository.refreshHealthAggregate(client);

    // platform_admin scope: the push channel carries the full-tenant view;
    // per-role filtering for the WS delivery path is a future extension
    // (BaseRealtimeGateway's own requiredRoles mechanism), out of this
    // WO's scope beyond the REST endpoint's already-enforced server-side
    // role scoping.
    const ctx: RequestActorContext = { tenantId, actorId: null, roles: ["platform_admin"] };

    try {
      // No request context here to have already set app.current_tenant
      // (unlike the REST path, which runs inside TenantContextMiddleware's
      // own transaction) — withTenantScope opens one, since the fan-out
      // query reads a tenant-RLS-scoped view.
      const snapshot = await this.repository.withTenantScope(tenantId, (scopedClient) => this.dashboardService.getFleetHealth(scopedClient, ctx, NO_FILTERS));
      await this.pubsub.publish(tenantId, "health", { payload: snapshot });
    } catch (err) {
      this.logger.warn(`failed to publish health update for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
