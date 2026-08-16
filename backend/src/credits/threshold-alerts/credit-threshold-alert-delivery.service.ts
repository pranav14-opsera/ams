import { Inject, Injectable, Logger } from "@nestjs/common";
import { PlatformRoleName } from "../../rbac/rbac.constants";
import { EncryptionService } from "../../encryption/encryption.service";
import { RedisPubSubService } from "../../websocket-gateway/redis-pubsub.service";
import { WebhookAlertChannelService } from "../../alerts/channels/webhook-alert-channel.service";
import { EMAIL_PROVIDER, type EmailProviderPort } from "../../alerts/ports/email-provider.port";
import { WebhookConfigRepository } from "../../alerts/webhook-config.repository";
import type { CreditAlertPayload } from "./credit-threshold-alert.types";

/**
 * AC: email (Team Lead + Finance Manager), webhook (if configured),
 * in-app (WebSocket). This is a genuinely SEPARATE delivery path from
 * WO-060's AlertDeliveryService/AlertEvent — that pipeline is agent-
 * centric (alert_events.agent_id is a NOT NULL FK, migration 046; its
 * EmailAlertChannelService looks up an agent by id for its template).
 * A credit threshold breach is TEAM-scoped with no agent at all, and its
 * own required payload shape (team_name, allocated/consumed/remaining
 * credits, projected exhaustion date) is entirely different content from
 * that pipeline's agent/metric-breach template — reusing it as-is would
 * either require fabricating a fake agent reference (the same
 * architectural mismatch WO-067 already found and worked around) or
 * silently rendering the WRONG content into a real notification. Instead
 * this reuses only the genuinely payload-agnostic, non-FK-coupled
 * pieces: WebhookConfigRepository (tenant-scoped, no agent concept at
 * all) + WebhookAlertChannelService.deliver() (a pure JSON.stringify +
 * HMAC-sign + POST, never touches alert_events), the same EMAIL_PROVIDER
 * port WO-060's own email channel wraps, and RedisPubSubService directly
 * for in-app delivery.
 */
@Injectable()
export class CreditThresholdAlertDeliveryService {
  private readonly logger = new Logger(CreditThresholdAlertDeliveryService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProviderPort,
    private readonly webhookConfigRepository: WebhookConfigRepository,
    private readonly encryptionService: EncryptionService,
    private readonly webhookChannel: WebhookAlertChannelService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  async deliver(tenantId: string, payload: CreditAlertPayload, recipientEmails: string[]): Promise<void> {
    await Promise.allSettled([this.deliverEmail(tenantId, payload, recipientEmails), this.deliverWebhooks(tenantId, payload), this.deliverInApp(tenantId, payload)]);
  }

  private async deliverEmail(_tenantId: string, payload: CreditAlertPayload, recipientEmails: string[]): Promise<void> {
    if (recipientEmails.length === 0) {
      this.logger.warn(`no Team Lead/Finance Manager recipients found for team ${payload.teamId} — credit threshold email skipped`);
      return;
    }
    try {
      const urgency = payload.thresholdLevel === 90 ? "URGENT" : "Notice";
      const html = this.renderEmail(payload);
      await this.emailProvider.send({ to: recipientEmails, subject: `[${urgency}] ${payload.teamName} has reached ${payload.thresholdLevel}% of its credit budget`, html });
    } catch (err) {
      this.logger.warn(`credit threshold email delivery failed for team ${payload.teamId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private renderEmail(payload: CreditAlertPayload): string {
    return `
      <h2>${payload.teamName}: ${payload.thresholdLevel}% credit budget threshold reached</h2>
      <p>Allocated: ${payload.allocatedCredits} credits</p>
      <p>Consumed: ${payload.consumedCredits} credits (${payload.consumptionPercentage}%)</p>
      <p>Remaining: ${payload.remainingCredits} credits</p>
      <p>${payload.projectedExhaustionDate ? `Projected exhaustion: ${payload.projectedExhaustionDate}` : "No recent consumption trend to project an exhaustion date from."}</p>
      <p><strong>${payload.recommendedAction}</strong></p>
    `.trim();
  }

  private async deliverWebhooks(tenantId: string, payload: CreditAlertPayload): Promise<void> {
    try {
      const rows = await this.webhookConfigRepository.findByTenantId(undefined, tenantId);
      const enabled = rows.filter((row) => row.enabled);
      await Promise.allSettled(
        enabled.map(async (row) => {
          const secret = (
            await this.encryptionService.decrypt(tenantId, {
              ciphertext: row.secret_ciphertext,
              iv: row.secret_iv,
              authTag: row.secret_auth_tag,
              encryptedDataKey: row.secret_encrypted_dek,
              keyVersion: row.secret_key_version,
            })
          ).toString("utf8");
          // WebhookAlertChannelService.deliver() only ever JSON.stringifies whatever it's given and signs/POSTs it — it has no dependency on the AlertEvent shape at runtime, so a credit-alert-shaped payload is a legitimate, honest use of the same class (see this file's own top-level doc comment).
          await this.webhookChannel.deliver(payload as any, { url: row.url, secret });
        }),
      );
    } catch (err) {
      this.logger.warn(`credit threshold webhook delivery failed for team ${payload.teamId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async deliverInApp(tenantId: string, payload: CreditAlertPayload): Promise<void> {
    try {
      await this.pubsub.publish(tenantId, "alerts", {
        requiredRoles: [PlatformRoleName.PLATFORM_ADMIN, PlatformRoleName.TEAM_LEAD, PlatformRoleName.FINANCE_MANAGER],
        payload: { type: "credit_threshold_alert", ...payload },
      });
    } catch (err) {
      this.logger.warn(`credit threshold in-app delivery failed for team ${payload.teamId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
