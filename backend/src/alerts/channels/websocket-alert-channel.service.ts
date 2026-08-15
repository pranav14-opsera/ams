import { Injectable } from "@nestjs/common";
import { PlatformRoleName } from "../../rbac/rbac.constants";
import { RedisPubSubService } from "../../websocket-gateway/redis-pubsub.service";
import type { AlertChannel, DeliveryResult } from "../alert-delivery.types";
import type { AlertEvent } from "../alert-threshold.types";

export interface WebSocketChannelConfig {
  // No per-channel config exists for in-app delivery — it's always enabled implicitly (there's no "disable in-app alerts" toggle in this WO's AC), unlike webhook/email which are explicitly configured per tenant.
}

/**
 * AC: in-app alerts pushed to AlertsGateway's "/ws/alerts" channel,
 * targeted at Administrators and Team Leads. `requiredRoles` reuses
 * BaseRealtimeGateway's existing role-filter mechanism (role-filter.ts,
 * WO-055) — team_lead is scoped tenant-wide here, not to their own
 * team's agents specifically, since no per-team WebSocket channel
 * splitting exists in this codebase (same documented simplification as
 * WO-057's team-scoping precedent when a finer mechanism doesn't exist).
 */
@Injectable()
export class WebSocketAlertChannelService implements AlertChannel<WebSocketChannelConfig> {
  readonly channelType = "websocket" as const;

  constructor(private readonly pubsub: RedisPubSubService) {}

  async deliver(alertEvent: AlertEvent, _config: WebSocketChannelConfig): Promise<DeliveryResult> {
    const startedAt = Date.now();
    try {
      await this.pubsub.publish(alertEvent.tenantId, "alerts", {
        requiredRoles: [PlatformRoleName.PLATFORM_ADMIN, PlatformRoleName.TEAM_LEAD],
        payload: alertEvent,
      });
      return { status: "sent", latencyMs: Date.now() - startedAt, errorMessage: null, attemptNumber: 1 };
    } catch (err) {
      return { status: "failed", latencyMs: Date.now() - startedAt, errorMessage: err instanceof Error ? err.message : String(err), attemptNumber: 1 };
    }
  }
}
