import { Module } from "@nestjs/common";
import { AdapterHealthModule } from "../adapters/health/adapter-health.module";
import { AlertsModule } from "../alerts/alerts.module";
import { AnomalyDetectionModule } from "../anomaly-detection/anomaly-detection.module";
import { CreditBudgetModule } from "../credits/budget/credit-budget.module";
import { EncryptionModule } from "../encryption/encryption.module";
import { QualityScoreModule } from "../quality-score/quality-score.module";
import { RbacModule } from "../rbac/rbac.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { WebsocketGatewayModule } from "../websocket-gateway/websocket-gateway.module";
import { AgentInFlightOperationsService } from "./agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "./agent-state-transitions.repository";
import { AgentsController } from "./agents.controller";
import { AgentsRepository } from "./agents.repository";
import { AgentsService } from "./agents.service";
import { BulkLifecycleService } from "./bulk-lifecycle.service";
import { ConnectionValidationService } from "./connection-validation.service";
import { LifecycleService } from "./lifecycle.service";

@Module({
  imports: [
    EncryptionModule,
    WebsocketGatewayModule,
    AdapterHealthModule,
    AlertsModule,
    AnomalyDetectionModule,
    QualityScoreModule,
    // RbacModule/CreditBudgetModule: WO-080's success-screen "applied RBAC
    // policies and credit budget" AC — AgentsService.findOne reads the
    // team-scoped role definitions and the team's current-period budget
    // allocation (if any) alongside the agent itself.
    RbacModule,
    CreditBudgetModule,
  ],
  controllers: [AgentsController],
  providers: [
    AgentsRepository,
    AgentsService,
    AgentStateTransitionsRepository,
    AgentInFlightOperationsService,
    LifecycleService,
    BulkLifecycleService,
    ConnectionValidationService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
  ],
  exports: [AgentsRepository, LifecycleService],
})
export class AgentsModule {}
