import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { RedisPubSubService } from "../../websocket-gateway/redis-pubsub.service";
import { OrgUsageDashboardRepository } from "./org-usage-dashboard.repository";
import { OrgUsageDashboardService, type OrgUsageActorContext } from "./org-usage-dashboard.service";
import type { OrgUsageUpdateMessage } from "./org-usage-dashboard.types";

/**
 * Bridges the org-usage read path to OrgUsageGateway's "org_usage"
 * channel — same shape as HealthMetricsPublisherService (WO-056). In
 * production this runs after each mock-telemetry-driven credit
 * transaction (the "Dashboard Pusher" component from the architecture
 * artifact) or on the aggregate views' own refresh interval, matching
 * this WO's 30-second/100ms-batched freshness AC; not wired to a live
 * Kafka-consumed scheduler in this sandbox (same class of substitution
 * already documented for every other "event-driven" trigger in this
 * codebase — WO-060/WO-069/WO-070's own reconciliation docs). publishUpdate
 * is exposed directly so integration tests can call it after inserting a
 * synthetic credit-consumption event, genuinely exercising the refresh ->
 * query -> publish chain end-to-end rather than stubbing it.
 */
@Injectable()
export class OrgUsagePublisherService {
  private readonly logger = new Logger(OrgUsagePublisherService.name);

  constructor(
    private readonly repository: OrgUsageDashboardRepository,
    private readonly dashboardService: OrgUsageDashboardService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  async publishUpdate(client: Pool | PoolClient | undefined, tenantId: string): Promise<void> {
    await this.repository.refreshAggregates(client);

    const ctx: OrgUsageActorContext = { tenantId, actorId: null };

    try {
      // No request context here to have already set app.current_tenant
      // (this runs outside any REST request, on a scheduler tick / from a
      // synthetic-event test) — withTenantScope opens its own scoped
      // transaction, same reasoning as HealthDashboardRepository's.
      const snapshot = await this.repository.withTenantScope(tenantId, (scopedClient) => this.dashboardService.getOrgUsageSummary(scopedClient, ctx));

      const message: OrgUsageUpdateMessage = {
        balance: snapshot.balance,
        burnRate: snapshot.burnRate,
        latestConsumption: snapshot.consumptionTrend.length > 0 ? snapshot.consumptionTrend[snapshot.consumptionTrend.length - 1] : null,
      };

      // BaseRealtimeGateway's `deliver` reads `.payload` off the published
      // message (see health-metrics-publisher.service.ts's own identical
      // `{ payload: snapshot }` shape) and puts THAT value into the
      // client's batch — publishing without this wrapper silently
      // delivers `undefined` (serialized as `null`) to every connected
      // client instead of the real update.
      await this.pubsub.publish(tenantId, "org_usage", { payload: { type: "usage_update", data: message, timestamp: new Date().toISOString() } });
    } catch (err) {
      this.logger.warn(`failed to publish org usage update for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
