import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AlertsGateway } from "./gateways/alerts.gateway";
import { ApprovalsGateway } from "./gateways/approvals.gateway";
import { DashboardGateway } from "./gateways/dashboard.gateway";
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
    AlertsGateway,
    ApprovalsGateway,
    ConnectionRegistryService,
    MessageBatcherService,
    RedisPubSubService,
    WsAuthService,
    WsConnectionLimitConfigService,
    WsMetricsService,
  ],
  exports: [WsMetricsService],
})
export class WebsocketGatewayModule {}
