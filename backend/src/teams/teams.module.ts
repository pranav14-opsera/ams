import { Module } from "@nestjs/common";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { TeamsController } from "./teams.controller";
import { TeamsRepository } from "./teams.repository";
import { TeamsService } from "./teams.service";

@Module({
  controllers: [TeamsController],
  providers: [TeamsRepository, TeamsService, { provide: AUDIT_SERVICE, useClass: PostgresAuditService }],
  exports: [TeamsRepository, TeamsService],
})
export class TeamsModule {}
