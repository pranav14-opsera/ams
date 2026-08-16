import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AlertsModule } from "../../alerts/alerts.module";
import { CreditsModule } from "../credits.module";
import { CreditThresholdAlertsModule } from "../threshold-alerts/credit-threshold-alerts.module";
import { CreditConsumptionDlqProducerService } from "./credit-consumption-dlq-producer.service";
import { CreditProcessedEventRepository } from "./credit-processed-event.repository";
import { CreditProcessedEventsCleanupSchedulerService } from "./credit-processed-events-cleanup.scheduler.service";
import { CreditReconciliationConsumerService } from "./credit-reconciliation-consumer.service";
import { CreditReconciliationHealthController } from "./credit-reconciliation-health.controller";
import { CreditReconciliationService } from "./credit-reconciliation.service";

@Module({
  imports: [ScheduleModule.forRoot(), CreditsModule, AlertsModule, CreditThresholdAlertsModule],
  controllers: [CreditReconciliationHealthController],
  providers: [
    CreditProcessedEventRepository,
    CreditConsumptionDlqProducerService,
    CreditReconciliationService,
    CreditReconciliationConsumerService,
    CreditProcessedEventsCleanupSchedulerService,
  ],
  exports: [CreditProcessedEventRepository, CreditReconciliationService],
})
export class CreditReconciliationModule {}
