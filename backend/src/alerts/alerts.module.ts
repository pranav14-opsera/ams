import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MetricsAggregatorRepository } from "../adapters/metrics/metrics-aggregator.repository";
import { AgentsRepository } from "../agents/agents.repository";
import { HealthDashboardRepository } from "../dashboard/health-dashboard.repository";
import { EncryptionModule } from "../encryption/encryption.module";
import { PhiScrubberModule } from "../phi-scrubber/phi-scrubber.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { WebsocketGatewayModule } from "../websocket-gateway/websocket-gateway.module";
import { AlertChannelConfigController } from "./alert-channel-config.controller";
import { AlertChannelConfigService } from "./alert-channel-config.service";
import { AlertDeliveryLogRepository } from "./alert-delivery-log.repository";
import { AlertDeliveryService } from "./alert-delivery.service";
import { AlertEventRepository } from "./alert-event.repository";
import { AlertThresholdController } from "./alert-threshold.controller";
import { AlertThresholdRepository } from "./alert-threshold.repository";
import { AlertThresholdService } from "./alert-threshold.service";
import { ChannelConfigCacheService } from "./channel-config-cache.service";
import { EmailAlertChannelService } from "./channels/email-alert-channel.service";
import { WebhookAlertChannelService } from "./channels/webhook-alert-channel.service";
import { WebSocketAlertChannelService } from "./channels/websocket-alert-channel.service";
import { EmailChannelConfigRepository } from "./email-channel-config.repository";
import { MetricSnapshotCacheService } from "./metric-snapshot-cache.service";
import { EMAIL_PROVIDER } from "./ports/email-provider.port";
import { InMemoryEmailProviderService } from "./ports/in-memory/in-memory-email-provider.service";
import { SesEmailProviderService } from "./ports/ses-email-provider.service";
import { AlertAutoTuneStateRepository } from "./suppression/alert-auto-tune-state.repository";
import { AlertFeedbackController } from "./suppression/alert-feedback.controller";
import { AlertFeedbackService } from "./suppression/alert-feedback.service";
import { AlertSnoozeRepository } from "./suppression/alert-snooze.repository";
import { AlertSuppressionService } from "./suppression/alert-suppression.service";
import { AutoTuneSchedulerService } from "./suppression/auto-tune.scheduler.service";
import { FalsePositiveFeedbackRepository } from "./suppression/false-positive-feedback.repository";
import { ThresholdEvaluationSchedulerService } from "./threshold-evaluation-scheduler.service";
import { ThresholdEvaluatorService } from "./threshold-evaluator.service";
import { WebhookConfigRepository } from "./webhook-config.repository";

// AUDIT_SERVICE isn't exported from a shared module in this codebase —
// every module that needs it re-provides its own PostgresAuditService
// binding (see dashboard.module.ts, subscription.module.ts, etc.).
//
// EMAIL_PROVIDER: same environment-switch pattern as encryption.module.ts's
// KMS_SERVICE — EMAIL_ADAPTER=mock (default) uses the in-memory double,
// EMAIL_ADAPTER=ses uses the real (uncredentialed-in-this-sandbox) AWS
// SESv2 client. Fails loudly on any other value rather than silently
// falling back.
@Module({
  imports: [ScheduleModule.forRoot(), WebsocketGatewayModule, EncryptionModule, PhiScrubberModule],
  controllers: [AlertThresholdController, AlertChannelConfigController, AlertFeedbackController],
  providers: [
    AlertThresholdRepository,
    AlertEventRepository,
    FalsePositiveFeedbackRepository,
    AlertSnoozeRepository,
    AlertAutoTuneStateRepository,
    AlertFeedbackService,
    AlertSuppressionService,
    AutoTuneSchedulerService,
    MetricSnapshotCacheService,
    HealthDashboardRepository,
    MetricsAggregatorRepository,
    AgentsRepository,
    WebhookConfigRepository,
    EmailChannelConfigRepository,
    AlertDeliveryLogRepository,
    ChannelConfigCacheService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    {
      provide: EMAIL_PROVIDER,
      useFactory: () => {
        const adapter = process.env.EMAIL_ADAPTER ?? "mock";
        if (adapter === "mock") return new InMemoryEmailProviderService();
        if (adapter === "ses") return new SesEmailProviderService();
        throw new Error(`EMAIL_ADAPTER=${adapter} is not implemented. Only "mock" and "ses" are available.`);
      },
    },
    WebSocketAlertChannelService,
    WebhookAlertChannelService,
    EmailAlertChannelService,
    AlertDeliveryService,
    AlertChannelConfigService,
    AlertThresholdService,
    ThresholdEvaluatorService,
    ThresholdEvaluationSchedulerService,
  ],
  exports: [AlertThresholdService, AlertThresholdRepository, AlertDeliveryService, AlertEventRepository, AlertSuppressionService],
})
export class AlertsModule {}
