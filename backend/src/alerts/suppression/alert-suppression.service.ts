import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { Pool, PoolClient } from "pg";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { DataClassification } from "../../classification/data-classification.enum";
import { AlertSnoozeRepository } from "./alert-snooze.repository";
import { AlertAutoTuneStateRepository } from "./alert-auto-tune-state.repository";
import { FalsePositiveFeedbackRepository } from "./false-positive-feedback.repository";
import { SNOOZE_DURATION_MS, type AlertSnoozeConfig, type SnoozeDuration, type SuppressionMetrics } from "./alert-suppression.types";

function snoozeKey(tenantId: string, agentId: string, metricName: string): string {
  return `alert:snooze:${tenantId}:${agentId}:${metricName}`;
}

/**
 * AC: manual snooze suppresses ANY severity (including critical) for the
 * duration chosen — an explicit user action, unlike auto-tuning (which
 * only ever widens the WARNING threshold and therefore, by construction,
 * never suppresses a critical breach — see ThresholdEvaluatorService).
 */
@Injectable()
export class AlertSuppressionService implements OnModuleDestroy {
  private readonly logger = new Logger(AlertSuppressionService.name);
  private readonly redis: Redis;

  constructor(
    private readonly snoozeRepository: AlertSnoozeRepository,
    private readonly autoTuneStateRepository: AlertAutoTuneStateRepository,
    private readonly feedbackRepository: FalsePositiveFeedbackRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.redis.on("error", () => undefined);
  }

  async createSnooze(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, agentId: string, metricName: string, duration: SnoozeDuration, now: Date = new Date()): Promise<AlertSnoozeConfig> {
    const snoozedUntil = new Date(now.getTime() + SNOOZE_DURATION_MS[duration]);
    const snooze = await this.snoozeRepository.upsert(client, tenantId, agentId, metricName, snoozedUntil, actorId);
    await this.redis.set(snoozeKey(tenantId, agentId, metricName), snoozedUntil.toISOString(), "EX", Math.ceil(SNOOZE_DURATION_MS[duration] / 1000)).catch(() => undefined);

    await this.auditService
      .recordEvent({ tenantId, actorId, action: "alert.snooze_created", resourceType: "alert_snooze_config", resourceId: snooze.id, details: { agentId, metricName, duration, snoozedUntil: snoozedUntil.toISOString() }, dataClassification: DataClassification.INTERNAL })
      .catch(() => undefined);

    return snooze;
  }

  async removeSnooze(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, id: string): Promise<void> {
    const removed = await this.snoozeRepository.remove(client, tenantId, id);
    if (!removed) return;
    await this.redis.del(snoozeKey(tenantId, removed.agentId, removed.metricName)).catch(() => undefined);

    await this.auditService
      .recordEvent({ tenantId, actorId, action: "alert.snooze_removed", resourceType: "alert_snooze_config", resourceId: id, details: { agentId: removed.agentId, metricName: removed.metricName }, dataClassification: DataClassification.INTERNAL })
      .catch(() => undefined);
  }

  /** Fast path: Redis. Falls back to Postgres on a cache miss/error (cold cache after a restart, or Redis unavailable) — never silently treats "can't reach Redis" as "not suppressed". */
  async isAlertSuppressed(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string, now: Date = new Date()): Promise<boolean> {
    try {
      const cached = await this.redis.get(snoozeKey(tenantId, agentId, metricName));
      if (cached !== null) return new Date(cached).getTime() > now.getTime();
    } catch (err) {
      this.logger.warn(`snooze cache lookup failed for ${tenantId}/${agentId}/${metricName}, falling back to Postgres: ${err instanceof Error ? err.message : err}`);
    }
    const active = await this.snoozeRepository.findActive(client, tenantId, agentId, metricName, now);
    return active !== null;
  }

  /** AC: the effective multiplier applied to a pattern's WARNING threshold only — never the critical one. */
  async getWarningMultiplier(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string): Promise<number> {
    return this.autoTuneStateRepository.getEffectiveMultiplier(client, tenantId, agentId, metricName);
  }

  async getSuppressionMetrics(client: Pool | PoolClient | undefined, tenantId: string): Promise<SuppressionMetrics> {
    const [falsePositiveRate, suppressedCount, feedbackCount, autoTunedCount] = await Promise.all([
      this.feedbackRepository.falsePositiveRateForTenant(client, tenantId),
      this.snoozeRepository.countActiveForTenant(client, tenantId),
      this.feedbackRepository.countForTenant(client, tenantId),
      this.autoTuneStateRepository.countTunedForTenant(client, tenantId),
    ]);
    return { falsePositiveRate, suppressedCount, feedbackCount, autoTunedCount };
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
