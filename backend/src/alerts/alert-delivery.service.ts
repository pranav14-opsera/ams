import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataClassification } from "../classification/data-classification.enum";
import { EncryptionService } from "../encryption/encryption.service";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { AlertDeliveryLogRepository } from "./alert-delivery-log.repository";
import type { AlertEvent } from "./alert-threshold.types";
import { ChannelConfigCacheService, type ResolvedChannelConfigs } from "./channel-config-cache.service";
import { EmailAlertChannelService } from "./channels/email-alert-channel.service";
import { WebhookAlertChannelService } from "./channels/webhook-alert-channel.service";
import { WebSocketAlertChannelService } from "./channels/websocket-alert-channel.service";
import { EmailChannelConfigRepository } from "./email-channel-config.repository";
import { WebhookConfigRepository } from "./webhook-config.repository";

@Injectable()
export class AlertDeliveryService {
  private readonly logger = new Logger(AlertDeliveryService.name);

  constructor(
    private readonly webhookConfigRepository: WebhookConfigRepository,
    private readonly emailConfigRepository: EmailChannelConfigRepository,
    private readonly configCache: ChannelConfigCacheService,
    private readonly encryptionService: EncryptionService,
    private readonly deliveryLogRepository: AlertDeliveryLogRepository,
    private readonly websocketChannel: WebSocketAlertChannelService,
    private readonly webhookChannel: WebhookAlertChannelService,
    private readonly emailChannel: EmailAlertChannelService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  /**
   * AC: consumed from Kafka in a real deployment — this sandbox has no
   * reachable Kafka broker (same documented gap as WO-041/043/046/055/059
   * throughout this codebase), so ThresholdEvaluatorService (WO-059)
   * calls this directly, in-process, immediately after publishing each
   * breach. The delivery logic itself — resolve configs, dispatch in
   * parallel, log, audit, idempotency-check — is genuine and fully
   * tested; only the transport hop from "event produced" to "delivery
   * triggered" is a direct call instead of a consumer group.
   */
  async deliver(alertEvent: AlertEvent): Promise<void> {
    const alreadyProcessed = await this.deliveryLogRepository.existsForAlertEvent(undefined, alertEvent.tenantId, alertEvent.id);
    if (alreadyProcessed) {
      this.logger.warn(`alert event ${alertEvent.id} already has delivery log entries — skipping duplicate delivery (idempotency)`);
      return;
    }

    const configs = await this.resolveChannelConfigs(alertEvent.tenantId);

    const deliveries: Array<Promise<void>> = [this.deliverAndLog(alertEvent, "websocket", () => this.websocketChannel.deliver(alertEvent, {}))];

    for (const webhook of configs.webhooks) {
      deliveries.push(this.deliverAndLog(alertEvent, "webhook", () => this.webhookChannel.deliver(alertEvent, webhook)));
    }
    for (const email of configs.emails) {
      deliveries.push(this.deliverAndLog(alertEvent, "email", () => this.emailChannel.deliver(alertEvent, email)));
    }

    await Promise.allSettled(deliveries);
  }

  private async deliverAndLog(alertEvent: AlertEvent, channelType: "websocket" | "webhook" | "email", run: () => Promise<{ status: string; latencyMs: number; errorMessage: string | null; attemptNumber: number }>): Promise<void> {
    const result = await run();
    await this.deliveryLogRepository
      .record(undefined, alertEvent.tenantId, alertEvent.id, {
        channelType,
        status: result.status as any,
        attemptNumber: result.attemptNumber,
        latencyMs: result.latencyMs,
        errorMessage: result.errorMessage,
      })
      .catch((err) => this.logger.warn(`failed to record delivery log for alert ${alertEvent.id} channel ${channelType}: ${err instanceof Error ? err.message : err}`));

    this.auditService
      .recordEvent({
        tenantId: alertEvent.tenantId,
        actorId: null,
        action: "alert_delivery.attempted",
        resourceType: "alert_event",
        resourceId: alertEvent.id,
        details: { channelType, status: result.status, attemptNumber: result.attemptNumber, errorMessage: result.errorMessage },
        dataClassification: DataClassification.INTERNAL,
      })
      .catch((err) => this.logger.warn(`failed to record delivery audit event: ${err instanceof Error ? err.message : err}`));
  }

  private async resolveChannelConfigs(tenantId: string): Promise<ResolvedChannelConfigs> {
    const cached = await this.configCache.get(tenantId);
    if (cached) return cached;

    const [webhookRows, emailRows] = await Promise.all([this.webhookConfigRepository.findByTenantId(undefined, tenantId), this.emailConfigRepository.findByTenantId(undefined, tenantId)]);

    const webhooks = await Promise.all(
      webhookRows
        .filter((row) => row.enabled)
        .map(async (row) => ({
          url: row.url,
          secret: (
            await this.encryptionService.decrypt(tenantId, {
              ciphertext: row.secret_ciphertext,
              iv: row.secret_iv,
              authTag: row.secret_auth_tag,
              encryptedDataKey: row.secret_encrypted_dek,
              keyVersion: row.secret_key_version,
            })
          ).toString("utf8"),
        })),
    );

    const emails = emailRows.filter((row) => row.enabled).map((row) => ({ recipients: row.recipients }));

    const resolved: ResolvedChannelConfigs = { webhooks, emails };
    await this.configCache.set(tenantId, resolved);
    return resolved;
  }
}
