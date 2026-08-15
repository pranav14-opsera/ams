import { Module } from "@nestjs/common";
import { AuditRetentionModule } from "../retention/audit-retention.module";
import { AuditLogController } from "./audit-log.controller";
import { AuditLogQueryRepository } from "./audit-log-query.repository";
import { AuditLogQueryService } from "./audit-log-query.service";

@Module({
  imports: [AuditRetentionModule],
  controllers: [AuditLogController],
  providers: [AuditLogQueryRepository, AuditLogQueryService],
  exports: [AuditLogQueryRepository, AuditLogQueryService],
})
export class AuditQueryModule {}
