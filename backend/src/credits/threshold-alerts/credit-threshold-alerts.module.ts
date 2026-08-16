import { Module } from "@nestjs/common";
import { AlertsModule } from "../../alerts/alerts.module";
import { EncryptionModule } from "../../encryption/encryption.module";
import { WebsocketGatewayModule } from "../../websocket-gateway/websocket-gateway.module";
import { CreditBudgetModule } from "../budget/credit-budget.module";
import { CreditThresholdAlertDeliveryService } from "./credit-threshold-alert-delivery.service";
import { CreditThresholdAlertRepository } from "./credit-threshold-alert.repository";
import { ThresholdMonitorService } from "./threshold-monitor.service";

@Module({
  // AlertsModule: only for WebhookAlertChannelService/WebhookConfigRepository (both tenant-scoped, no agent coupling at runtime — see CreditThresholdAlertDeliveryService's own doc comment on why this WO doesn't reuse AlertDeliveryService itself).
  imports: [AlertsModule, EncryptionModule, WebsocketGatewayModule, CreditBudgetModule],
  providers: [CreditThresholdAlertRepository, CreditThresholdAlertDeliveryService, ThresholdMonitorService],
  exports: [CreditThresholdAlertRepository, ThresholdMonitorService],
})
export class CreditThresholdAlertsModule {}
