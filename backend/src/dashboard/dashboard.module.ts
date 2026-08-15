import { Module } from "@nestjs/common";
import { PhiScrubberModule } from "../phi-scrubber/phi-scrubber.module";
import { RbacModule } from "../rbac/rbac.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { WebsocketGatewayModule } from "../websocket-gateway/websocket-gateway.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { HealthCacheService } from "./health-cache.service";
import { HealthDashboardRepository } from "./health-dashboard.repository";
import { HealthMetricsPublisherService } from "./health-metrics-publisher.service";

// AUDIT_SERVICE isn't exported from a shared module in this codebase —
// every module that needs it re-provides its own PostgresAuditService
// binding (see subscription.module.ts, audit-retention.module.ts, etc.).
@Module({
  imports: [RbacModule, PhiScrubberModule, WebsocketGatewayModule],
  controllers: [DashboardController],
  providers: [
    HealthDashboardRepository,
    HealthCacheService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    DashboardService,
    HealthMetricsPublisherService,
  ],
  exports: [HealthDashboardRepository, DashboardService, HealthMetricsPublisherService],
})
export class DashboardModule {}
