import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AlertsGateway } from "./gateways/alerts.gateway";
import { ApprovalsGateway } from "./gateways/approvals.gateway";
import { DashboardGateway } from "./gateways/dashboard.gateway";
import { HealthGateway } from "./gateways/health.gateway";
import { ConnectionRegistryService } from "./connection-registry.service";
import { MessageBatcherService } from "./message-batcher.service";
import { RedisPubSubService } from "./redis-pubsub.service";
import { WsAuthService } from "./ws-auth.service";
import { WsConnectionLimitConfigService } from "./ws-connection-limit-config.service";
import { WsMetricsService } from "./ws-metrics.service";

@Module({
  imports: [AuthModule], // JWT_VERIFIER (WsAuthService's dependency) is provided there
  providers: [
    DashboardGateway,
    HealthGateway,
    AlertsGateway,
    ApprovalsGateway,
    ConnectionRegistryService,
    MessageBatcherService,
    RedisPubSubService,
    WsAuthService,
    WsConnectionLimitConfigService,
    WsMetricsService,
  ],
  // RedisPubSubService exported so other modules (e.g. AgentsModule's
  // lifecycle transition events) can reuse this one publisher/subscriber
  // connection pair instead of each standing up its own.
  exports: [WsMetricsService, RedisPubSubService],
})
export class WebsocketGatewayModule {}
