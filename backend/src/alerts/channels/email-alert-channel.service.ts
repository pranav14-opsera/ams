import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import * as Handlebars from "handlebars";
import Redis from "ioredis";
import { AgentsRepository } from "../../agents/agents.repository";
import { PhiScrubberService } from "../../phi-scrubber/phi-scrubber.service";
import { EMAIL_PROVIDER, type EmailProviderPort } from "../ports/email-provider.port";
import { THRESHOLD_BREACH_TEMPLATE_SOURCE } from "../templates/threshold-breach.template";
import type { AlertChannel, DeliveryResult } from "../alert-delivery.types";
import type { AlertEvent } from "../alert-threshold.types";

export interface EmailChannelConfig {
  recipients: string[];
}

const RATE_LIMIT_PER_HOUR = 100;
const DETAIL_URL_BASE = process.env.ALERT_DETAIL_URL_BASE ?? "https://app.example.com";

function rateLimitKey(tenantId: string): string {
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return `alerts:email-rate-limit:${tenantId}:${hourBucket}`;
}

/** AC: email delivery via SES/SendGrid with a Handlebars template, per-tenant rate limiting (100/hour). PHI-scrubbed before rendering — agent `name` is free text an operator chose, same risk surface WO-056/057 already established. */
@Injectable()
export class EmailAlertChannelService implements AlertChannel<EmailChannelConfig>, OnModuleDestroy {
  readonly channelType = "email" as const;
  private readonly template = Handlebars.compile(THRESHOLD_BREACH_TEMPLATE_SOURCE);
  private readonly redis: Redis;

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProviderPort,
    private readonly agentsRepository: AgentsRepository,
    private readonly phiScrubber: PhiScrubberService,
  ) {
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.redis.on("error", () => undefined);
  }

  async deliver(alertEvent: AlertEvent, config: EmailChannelConfig): Promise<DeliveryResult> {
    const startedAt = Date.now();

    const withinLimit = await this.checkAndIncrementRateLimit(alertEvent.tenantId);
    if (!withinLimit) {
      return { status: "failed", latencyMs: Date.now() - startedAt, errorMessage: "tenant email rate limit exceeded (100/hour)", attemptNumber: 1 };
    }

    try {
      const agent = await this.agentsRepository.findOne(undefined, alertEvent.tenantId, alertEvent.agentId);
      const agentName = this.phiScrubber.scrubText(agent?.name ?? "unknown agent", null);

      const html = this.template({
        agentName,
        metricName: alertEvent.metricName,
        thresholdValue: alertEvent.thresholdValue,
        actualValue: alertEvent.actualValue,
        severityLabel: alertEvent.severity === "critical" ? "CRITICAL" : "Warning",
        breachTimestamp: alertEvent.breachTimestamp.toISOString(),
        detailUrl: `${DETAIL_URL_BASE}/agents/health/detail?agentId=${alertEvent.agentId}`,
      });

      await this.emailProvider.send({ to: config.recipients, subject: `[${alertEvent.severity.toUpperCase()}] ${agentName} — ${alertEvent.metricName} threshold breached`, html });

      return { status: "sent", latencyMs: Date.now() - startedAt, errorMessage: null, attemptNumber: 1 };
    } catch (err) {
      return { status: "failed", latencyMs: Date.now() - startedAt, errorMessage: err instanceof Error ? err.message : String(err), attemptNumber: 1 };
    }
  }

  private async checkAndIncrementRateLimit(tenantId: string): Promise<boolean> {
    try {
      const key = rateLimitKey(tenantId);
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 3600);
      return count <= RATE_LIMIT_PER_HOUR;
    } catch {
      return true; // Redis unavailable — fail open rather than silently dropping every alert email.
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
