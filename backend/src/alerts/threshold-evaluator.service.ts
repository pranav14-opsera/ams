import { Injectable, Logger } from "@nestjs/common";
import { HealthDashboardRepository } from "../dashboard/health-dashboard.repository";
import { AlertDeliveryService } from "./alert-delivery.service";
import { AlertEventRepository } from "./alert-event.repository";
import { AlertThresholdRepository } from "./alert-threshold.repository";
import { MetricSnapshotCacheService, type MetricSnapshot } from "./metric-snapshot-cache.service";
import type { AlertEvent, AlertSeverity, AlertThresholdConfig } from "./alert-threshold.types";

/** 5s health-aggregate bucket -> "per minute" rate, so token_consumption_rate thresholds (defined per-minute, per this WO's own AC) compare against a like-for-like unit. */
const TOKENS_PER_5S_TO_PER_MINUTE = 12;

@Injectable()
export class ThresholdEvaluatorService {
  private readonly logger = new Logger(ThresholdEvaluatorService.name);

  constructor(
    private readonly thresholdRepository: AlertThresholdRepository,
    private readonly eventRepository: AlertEventRepository,
    private readonly snapshotCache: MetricSnapshotCacheService,
    private readonly healthRepository: HealthDashboardRepository,
    private readonly alertDeliveryService: AlertDeliveryService,
  ) {}

  /**
   * One tick for one tenant: refresh the Redis snapshot cache from the
   * latest health-aggregate data (the same data DashboardService reads —
   * WO-056/057), then evaluate every configured threshold against it.
   * `resource_utilization` is never populated here: no metric pipeline
   * anywhere in this codebase computes it yet (same documented gap as
   * WO-056/057's own AC #1) — a threshold configured for it simply never
   * finds a snapshot value and is silently skipped, not fabricated.
   */
  async evaluateTenant(tenantId: string, now: Date = new Date()): Promise<AlertEvent[]> {
    const thresholds = await this.thresholdRepository.findAllForTenant(undefined, tenantId);
    if (thresholds.length === 0) return [];

    const agentIds = [...new Set(thresholds.map((t) => t.agentId))];

    const fleetHealth = await this.healthRepository.withTenantScope(tenantId, (client) => this.healthRepository.findFleetHealth(client, tenantId, { teamIds: null, limit: 1000, offset: 0 }));

    const activeAgentIds: string[] = [];
    for (const row of fleetHealth.rows) {
      if (!agentIds.includes(row.id)) continue;
      // AC/implementation step: a paused (or retired/decommissioned) agent is skipped entirely, not evaluated against stale last-known metrics.
      if (row.lifecycleStatus !== "active" && row.lifecycleStatus !== "connecting") continue;
      if (row.metricsBucket === null) continue; // no metrics recorded yet — nothing to evaluate

      const snapshot: MetricSnapshot = {
        error_rate: row.errorRateAvg ?? undefined,
        latency_p99: row.latencyP99Ms ?? undefined,
        token_consumption_rate: row.tokenConsumptionTotal !== null ? row.tokenConsumptionTotal * TOKENS_PER_5S_TO_PER_MINUTE : undefined,
      };
      await this.snapshotCache.setSnapshot(tenantId, row.id, snapshot);
      activeAgentIds.push(row.id);
    }

    const snapshots = await this.snapshotCache.getSnapshots(tenantId, activeAgentIds);
    const generatedEvents: AlertEvent[] = [];

    for (const threshold of thresholds) {
      const snapshot = snapshots.get(threshold.agentId);
      if (!snapshot) continue;
      const actualValue = snapshot[threshold.metricName];
      if (actualValue === undefined) continue;

      const severity = this.classifySeverity(actualValue, threshold);
      if (!severity) continue;

      const withinCooldown = await this.isWithinCooldown(tenantId, threshold, now);
      if (withinCooldown) continue;

      const event = await this.eventRepository.create(undefined, tenantId, threshold.agentId, {
        metricName: threshold.metricName,
        thresholdValue: severity === "critical" ? threshold.criticalThreshold : threshold.warningThreshold,
        actualValue,
        severity,
        breachTimestamp: now,
      });

      generatedEvents.push(event);
      // WO-060: AlertDeliveryService is now the single owner of "how an
      // alert reaches every configured channel" (websocket/webhook/
      // email) — this evaluator no longer publishes to the WS channel
      // directly itself (that would double-deliver alongside
      // AlertDeliveryService's own WebSocketAlertChannelService).
      await this.alertDeliveryService.deliver(event).catch((err) => this.logger.warn(`alert delivery failed for event ${event.id}: ${err instanceof Error ? err.message : err}`));
    }

    return generatedEvents;
  }

  private classifySeverity(actualValue: number, threshold: AlertThresholdConfig): AlertSeverity | null {
    if (actualValue > threshold.criticalThreshold) return "critical";
    if (actualValue > threshold.warningThreshold) return "warning";
    return null;
  }

  private async isWithinCooldown(tenantId: string, threshold: AlertThresholdConfig, now: Date): Promise<boolean> {
    const mostRecent = await this.eventRepository.findMostRecent(undefined, tenantId, threshold.agentId, threshold.metricName);
    if (!mostRecent) return false;
    const elapsedSeconds = (now.getTime() - mostRecent.breachTimestamp.getTime()) / 1000;
    return elapsedSeconds < threshold.cooldownSeconds;
  }
}
