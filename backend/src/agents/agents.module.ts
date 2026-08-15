import { Module } from "@nestjs/common";
import { AdapterHealthModule } from "../adapters/health/adapter-health.module";
import { AlertsModule } from "../alerts/alerts.module";
import { AnomalyDetectionModule } from "../anomaly-detection/anomaly-detection.module";
import { EncryptionModule } from "../encryption/encryption.module";
import { QualityScoreModule } from "../quality-score/quality-score.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { WebsocketGatewayModule } from "../websocket-gateway/websocket-gateway.module";
import { AgentInFlightOperationsService } from "./agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "./agent-state-transitions.repository";
import { AgentsController } from "./agents.controller";
import { AgentsRepository } from "./agents.repository";
import { AgentsService } from "./agents.service";
import { BulkLifecycleService } from "./bulk-lifecycle.service";
import { LifecycleService } from "./lifecycle.service";

@Module({
  imports: [EncryptionModule, WebsocketGatewayModule, AdapterHealthModule, AlertsModule, AnomalyDetectionModule, QualityScoreModule],
  controllers: [AgentsController],
  providers: [
    AgentsRepository,
    AgentsService,
    AgentStateTransitionsRepository,
    AgentInFlightOperationsService,
    LifecycleService,
    BulkLifecycleService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
  ],
})
export class AgentsModule {}
