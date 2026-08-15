import { Module } from "@nestjs/common";
import { AdapterHealthModule } from "../adapters/health/adapter-health.module";
import { EncryptionModule } from "../encryption/encryption.module";
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
  imports: [EncryptionModule, WebsocketGatewayModule, AdapterHealthModule],
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
