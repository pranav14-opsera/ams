import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { RedisPubSubService } from "../../websocket-gateway/redis-pubsub.service";
import { TeamUsageDashboardService, type TeamUsageActorContext } from "./team-usage-dashboard.service";
import type { TeamUsageUpdateMessage } from "./team-usage-dashboard.types";

/**
 * Bridges the team-usage read path to TeamUsageGateway's "team_usage"
 * channel — same shape as OrgUsagePublisherService (WO-074). Publishes on
 * the tenant-wide "team_usage" pub/sub channel (RedisPubSubService keys
 * by tenant, not team — see its own tenantChannel() helper) with the
 * team_id carried IN the payload; every connected client for the tenant
 * receives every team's update and the frontend hook filters to the
 * team it's currently viewing (useTeamUsageSubscription). This is an
 * honest reuse of WO-074's existing tenant-scoped pub/sub infrastructure
 * rather than building a genuinely team-partitioned channel — documented
 * in this WO's own reconciliation doc as the deliberate trade made to
 * avoid duplicating/forking the WebSocket gateway stack for a real
 * per-team topic.
 */
@Injectable()
export class TeamUsagePublisherService {
  private readonly logger = new Logger(TeamUsagePublisherService.name);

  // No refreshAggregates() call here (unlike OrgUsagePublisherService) —
  // TeamUsageDashboardRepository queries credit_transactions directly,
  // not a materialized view that needs a manual refresh first (see its
  // own doc comment on why).
  constructor(
    private readonly dashboardService: TeamUsageDashboardService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  async publishUpdate(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<void> {
    const ctx: TeamUsageActorContext = { tenantId, actorId: null, roles: ["platform_admin"] };

    try {
      const snapshot = await this.dashboardService.getTeamUsageSummary(client, ctx, teamId);

      const message: TeamUsageUpdateMessage = {
        teamId,
        balance: snapshot.balance,
        burnRate: snapshot.burnRate,
        latestConsumption: snapshot.consumptionTrend.length > 0 ? snapshot.consumptionTrend[snapshot.consumptionTrend.length - 1] : null,
      };

      // Same `{ payload: { ... } }` wrapper BaseRealtimeGateway.deliver
      // expects — see OrgUsagePublisherService's own identical comment on
      // why omitting this silently delivers `null` to every client.
      await this.pubsub.publish(tenantId, "team_usage", { payload: { type: "team_usage_update", data: message, timestamp: new Date().toISOString() } });
    } catch (err) {
      this.logger.warn(`failed to publish team usage update for tenant ${tenantId} team ${teamId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
