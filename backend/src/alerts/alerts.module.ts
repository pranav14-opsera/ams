import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthDashboardRepository } from "../dashboard/health-dashboard.repository";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { WebsocketGatewayModule } from "../websocket-gateway/websocket-gateway.module";
import { AlertEventRepository } from "./alert-event.repository";
import { AlertThresholdController } from "./alert-threshold.controller";
import { AlertThresholdRepository } from "./alert-threshold.repository";
import { AlertThresholdService } from "./alert-threshold.service";
import { MetricSnapshotCacheService } from "./metric-snapshot-cache.service";
import { ThresholdEvaluationSchedulerService } from "./threshold-evaluation-scheduler.service";
import { ThresholdEvaluatorService } from "./threshold-evaluator.service";

// AUDIT_SERVICE isn't exported from a shared module in this codebase —
// every module that needs it re-provides its own PostgresAuditService
// binding (see dashboard.module.ts, subscription.module.ts, etc.).
@Module({
  imports: [ScheduleModule.forRoot(), WebsocketGatewayModule],
  controllers: [AlertThresholdController],
  providers: [
    AlertThresholdRepository,
    AlertEventRepository,
    MetricSnapshotCacheService,
    HealthDashboardRepository,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    AlertThresholdService,
    ThresholdEvaluatorService,
    ThresholdEvaluationSchedulerService,
  ],
  exports: [AlertThresholdService, AlertThresholdRepository],
})
export class AlertsModule {}
