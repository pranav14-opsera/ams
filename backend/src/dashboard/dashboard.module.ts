import { Module } from "@nestjs/common";
import { MetricsAggregatorRepository } from "../adapters/metrics/metrics-aggregator.repository";
import { AgentStateTransitionsRepository } from "../agents/agent-state-transitions.repository";
import { AgentsRepository } from "../agents/agents.repository";
import { AnomalyDetectionModule } from "../anomaly-detection/anomaly-detection.module";
import { PhiScrubberModule } from "../phi-scrubber/phi-scrubber.module";
import { QualityScoreModule } from "../quality-score/quality-score.module";
import { RbacModule } from "../rbac/rbac.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { TraceModule } from "../traces/trace.module";
import { WebsocketGatewayModule } from "../websocket-gateway/websocket-gateway.module";
import { AgentHealthDetailController } from "./agent-health-detail.controller";
import { AgentHealthDetailService } from "./agent-health-detail.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { HealthCacheService } from "./health-cache.service";
import { HealthDashboardRepository } from "./health-dashboard.repository";
import { HealthMetricsPublisherService } from "./health-metrics-publisher.service";

// AUDIT_SERVICE isn't exported from a shared module in this codebase —
// every module that needs it re-provides its own PostgresAuditService
// binding (see subscription.module.ts, audit-retention.module.ts, etc.).
@Module({
  imports: [RbacModule, PhiScrubberModule, WebsocketGatewayModule, TraceModule, AnomalyDetectionModule, QualityScoreModule],
  controllers: [DashboardController, AgentHealthDetailController],
  providers: [
    HealthDashboardRepository,
    HealthCacheService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    DashboardService,
    HealthMetricsPublisherService,
    // WO-057: single-agent drill-down — re-provided here rather than
    // importing AgentsModule/AdaptersModule wholesale (both repositories
    // depend only on the global PG_POOL, same "just re-provide the
    // repository" pattern this codebase already uses for AUDIT_SERVICE).
    AgentsRepository,
    MetricsAggregatorRepository,
    AgentStateTransitionsRepository,
    AgentHealthDetailService,
  ],
  exports: [HealthDashboardRepository, DashboardService, HealthMetricsPublisherService],
})
export class DashboardModule {}
