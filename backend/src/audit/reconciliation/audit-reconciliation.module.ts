import { Module } from "@nestjs/common";
import { AuditEventsModule } from "../events/audit-events.module";
import { AuditDeepSampleService } from "./audit-deep-sample.service";
import { AuditReconciliationController } from "./audit-reconciliation.controller";
import { AuditReconciliationReportRepository } from "./audit-reconciliation-report.repository";
import { AuditReconciliationService } from "./audit-reconciliation.service";
import { AuditReplayService } from "./audit-replay.service";

// AuditIngestionCounterRepository is already provided by (and exported
// through) AuditEventsModule, which increments it from
// AuditEventConsumerPipelineService — a single shared instance, not a
// duplicate one declared here too.
@Module({
  imports: [AuditEventsModule],
  controllers: [AuditReconciliationController],
  providers: [AuditReconciliationReportRepository, AuditReconciliationService, AuditDeepSampleService, AuditReplayService],
  exports: [AuditReconciliationReportRepository, AuditReconciliationService, AuditDeepSampleService, AuditReplayService],
})
export class AuditReconciliationModule {}
