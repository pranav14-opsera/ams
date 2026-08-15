import { Module } from "@nestjs/common";
import { AuditLogController } from "./audit-log.controller";
import { AuditLogQueryRepository } from "./audit-log-query.repository";
import { AuditLogQueryService } from "./audit-log-query.service";

@Module({
  controllers: [AuditLogController],
  providers: [AuditLogQueryRepository, AuditLogQueryService],
  exports: [AuditLogQueryRepository, AuditLogQueryService],
})
export class AuditQueryModule {}
