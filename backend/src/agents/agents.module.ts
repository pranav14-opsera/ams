import { Module } from "@nestjs/common";
import { EncryptionModule } from "../encryption/encryption.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { AgentsController } from "./agents.controller";
import { AgentsRepository } from "./agents.repository";
import { AgentsService } from "./agents.service";

@Module({
  imports: [EncryptionModule],
  controllers: [AgentsController],
  providers: [AgentsRepository, AgentsService, { provide: AUDIT_SERVICE, useClass: PostgresAuditService }],
})
export class AgentsModule {}
