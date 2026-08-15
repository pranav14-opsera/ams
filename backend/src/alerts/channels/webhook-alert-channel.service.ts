import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHmac } from "node:crypto";
import type { AlertChannel, DeliveryResult } from "../alert-delivery.types";
import type { AlertEvent } from "../alert-threshold.types";

export interface WebhookChannelConfig {
  url: string;
  /** Raw (already-decrypted) HMAC signing secret — WebhookConfigRepository decrypts it via EncryptionService before this is ever constructed; this class itself never touches ciphertext. */
  secret: string;
}

export const WEBHOOK_RETRY_DELAYS_MS = "WEBHOOK_RETRY_DELAYS_MS";
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 25_000]; // AC: 1s, 5s, 25s
const REQUEST_TIMEOUT_MS = 10_000;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** AC: HMAC-SHA256-signed HTTP POST, exponential backoff retry (3 attempts). Genuinely testable end-to-end against a real local HTTP server — no external dependency needed for a webhook, unlike email/Kafka. */
@Injectable()
export class WebhookAlertChannelService implements AlertChannel<WebhookChannelConfig> {
  readonly channelType = "webhook" as const;
  private readonly logger = new Logger(WebhookAlertChannelService.name);

  /**
   * retryDelaysMs is only ever overridden by tests, to avoid a genuine
   * 31-second real-time wait for the "exhausts all retries" case —
   * production always uses the AC's own 1s/5s/25s (the module doesn't
   * provide WEBHOOK_RETRY_DELAYS_MS at all, so this falls back to the
   * default). `@Optional()` + an explicit token (rather than a bare
   * `number[]` default param) so NestJS's DI container knows how to
   * resolve this constructor argument at all — a plain array type with
   * no injection token isn't something Nest can look up.
   */
  constructor(@Optional() @Inject(WEBHOOK_RETRY_DELAYS_MS) private readonly retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS) {}

  async deliver(alertEvent: AlertEvent, config: WebhookChannelConfig): Promise<DeliveryResult> {
    const body = JSON.stringify(alertEvent);
    const signature = sign(config.secret, body);
    const startedAt = Date.now();

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= this.retryDelaysMs.length + 1; attempt++) {
      try {
        const response = await this.postWithTimeout(config.url, body, signature);
        if (response.ok) {
          return { status: attempt === 1 ? "sent" : "delivered", latencyMs: Date.now() - startedAt, errorMessage: null, attemptNumber: attempt };
        }
        lastError = `webhook endpoint responded ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      const delayMs = this.retryDelaysMs[attempt - 1];
      if (delayMs !== undefined) {
        this.logger.warn(`webhook delivery attempt ${attempt} failed for alert ${alertEvent.id}: ${lastError} — retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return { status: "failed", latencyMs: Date.now() - startedAt, errorMessage: lastError, attemptNumber: this.retryDelaysMs.length + 1 };
  }

  private async postWithTimeout(url: string, body: string, signature: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature-256": `sha256=${signature}` },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
