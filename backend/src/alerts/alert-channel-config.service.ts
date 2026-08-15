import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DataClassification } from "../classification/data-classification.enum";
import { EncryptionService } from "../encryption/encryption.service";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import type { ChannelType } from "./alert-delivery.types";
import { ChannelConfigCacheService } from "./channel-config-cache.service";
import { WebhookAlertChannelService } from "./channels/webhook-alert-channel.service";
import { EmailAlertChannelService } from "./channels/email-alert-channel.service";
import { WebSocketAlertChannelService } from "./channels/websocket-alert-channel.service";
import { EmailChannelConfigRepository } from "./email-channel-config.repository";
import { WebhookConfigRepository } from "./webhook-config.repository";
import type { AlertEvent } from "./alert-threshold.types";

/** GET responses never include the raw secret — masked to its last 4 characters, same "never re-expose a write-only secret" convention as agents.connection_config. */
export interface MaskedWebhookConfig {
  id: string;
  url: string;
  enabled: boolean;
  secretMasked: string;
}

export interface EmailChannelConfigView {
  id: string;
  recipients: string[];
  enabled: boolean;
}

const SYNTHETIC_TEST_EVENT: Omit<AlertEvent, "id" | "tenantId"> = {
  agentId: "00000000-0000-0000-0000-000000000000",
  metricName: "error_rate",
  thresholdValue: 0.05,
  actualValue: 0.99,
  severity: "critical",
  breachTimestamp: new Date(0),
};

@Injectable()
export class AlertChannelConfigService {
  constructor(
    private readonly webhookRepository: WebhookConfigRepository,
    private readonly emailRepository: EmailChannelConfigRepository,
    private readonly encryptionService: EncryptionService,
    private readonly configCache: ChannelConfigCacheService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
    private readonly websocketChannel: WebSocketAlertChannelService,
    private readonly webhookChannel: WebhookAlertChannelService,
    private readonly emailChannel: EmailAlertChannelService,
  ) {}

  async createWebhook(tenantId: string, actorId: string | null, url: string, secret: string): Promise<MaskedWebhookConfig> {
    const encryptedSecret = await this.encryptionService.encrypt(tenantId, Buffer.from(secret, "utf8"));
    const row = await this.webhookRepository.create(undefined, tenantId, url, encryptedSecret, actorId);
    await this.configCache.invalidate(tenantId);
    this.recordAudit(tenantId, actorId, "alert_channel.webhook_created", row.id, { url });
    return { id: row.id, url: row.url, enabled: row.enabled, secretMasked: maskSecret(secret) };
  }

  async listWebhooks(tenantId: string): Promise<MaskedWebhookConfig[]> {
    const rows = await this.webhookRepository.findByTenantId(undefined, tenantId);
    return rows.map((row) => ({ id: row.id, url: row.url, enabled: row.enabled, secretMasked: "****" }));
  }

  async setWebhookEnabled(tenantId: string, actorId: string | null, id: string, enabled: boolean): Promise<void> {
    const updated = await this.webhookRepository.setEnabled(undefined, tenantId, id, enabled);
    if (!updated) throw new NotFoundException(`Webhook config ${id} not found.`);
    await this.configCache.invalidate(tenantId);
    this.recordAudit(tenantId, actorId, enabled ? "alert_channel.webhook_enabled" : "alert_channel.webhook_disabled", id, {});
  }

  async deleteWebhook(tenantId: string, actorId: string | null, id: string): Promise<void> {
    const deleted = await this.webhookRepository.delete(undefined, tenantId, id);
    if (!deleted) throw new NotFoundException(`Webhook config ${id} not found.`);
    await this.configCache.invalidate(tenantId);
    this.recordAudit(tenantId, actorId, "alert_channel.webhook_deleted", id, {});
  }

  async createEmailChannel(tenantId: string, actorId: string | null, recipients: string[]): Promise<EmailChannelConfigView> {
    const row = await this.emailRepository.create(undefined, tenantId, recipients, actorId);
    await this.configCache.invalidate(tenantId);
    this.recordAudit(tenantId, actorId, "alert_channel.email_created", row.id, { recipientCount: recipients.length });
    return { id: row.id, recipients: row.recipients, enabled: row.enabled };
  }

  async listEmailChannels(tenantId: string): Promise<EmailChannelConfigView[]> {
    const rows = await this.emailRepository.findByTenantId(undefined, tenantId);
    return rows.map((row) => ({ id: row.id, recipients: row.recipients, enabled: row.enabled }));
  }

  /** AC: channel connectivity test endpoint — sends a genuine synthetic alert through the real channel implementation (real HMAC signature, real HTTP POST / real SES call), so a caller learns about a broken URL/credential BEFORE relying on it in production. */
  async testChannel(tenantId: string, channelType: ChannelType, configId: string | undefined) {
    const testEvent: AlertEvent = { id: "test-event", tenantId, ...SYNTHETIC_TEST_EVENT };

    if (channelType === "websocket") {
      return this.websocketChannel.deliver(testEvent, {});
    }
    if (channelType === "webhook") {
      if (!configId) throw new BadRequestException("configId is required to test a webhook channel.");
      const row = await this.webhookRepository.findOne(undefined, tenantId, configId);
      if (!row) throw new NotFoundException(`Webhook config ${configId} not found.`);
      const secret = await this.encryptionService.decrypt(tenantId, {
        ciphertext: row.secret_ciphertext,
        iv: row.secret_iv,
        authTag: row.secret_auth_tag,
        encryptedDataKey: row.secret_encrypted_dek,
        keyVersion: row.secret_key_version,
      });
      return this.webhookChannel.deliver(testEvent, { url: row.url, secret: secret.toString("utf8") });
    }
    if (!configId) throw new BadRequestException("configId is required to test an email channel.");
    const row = await this.emailRepository.findByTenantId(undefined, tenantId).then((rows) => rows.find((r) => r.id === configId));
    if (!row) throw new NotFoundException(`Email channel config ${configId} not found.`);
    return this.emailChannel.deliver(testEvent, { recipients: row.recipients });
  }

  private recordAudit(tenantId: string, actorId: string | null, action: string, resourceId: string, details: Record<string, unknown>): void {
    this.auditService
      .recordEvent({ tenantId, actorId, action, resourceType: "alert_channel_config", resourceId, details, dataClassification: DataClassification.INTERNAL })
      .catch(() => undefined);
  }
}

function maskSecret(secret: string): string {
  return secret.length <= 4 ? "****" : `****${secret.slice(-4)}`;
}
