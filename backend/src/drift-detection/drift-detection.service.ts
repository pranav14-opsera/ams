import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { twoSampleKsTest } from "../algorithms/ks-test";
import { AlertDeliveryService } from "../alerts/alert-delivery.service";
import { AlertEventRepository } from "../alerts/alert-event.repository";
import type { AlertEvent, AlertSeverity } from "../alerts/alert-threshold.types";
import { AlertSuppressionService } from "../alerts/suppression/alert-suppression.service";
import { QualityScoreRepository } from "../quality-score/quality-score.repository";
import { DriftEventRepository } from "./drift-event.repository";
import { DriftStateCacheService } from "./drift-state-cache.service";
import { DriftStateRepository } from "./drift-state.repository";
import { CONSECUTIVE_WINDOWS_REQUIRED, DEFAULT_P_VALUE_THRESHOLD, RECENT_LOOKBACK_HOURS, type ComponentDeltas, type DriftEvaluation, type DriftStatus } from "./drift-detection.types";

const DRIFT_METRIC_NAME = "quality_drift";
const ALERT_COOLDOWN_SECONDS = 3600; // one evaluation window — prevents a scheduler retry within the same hour from double-firing the same drift episode

@Injectable()
export class DriftDetectionService {
  private readonly logger = new Logger(DriftDetectionService.name);

  constructor(
    private readonly qualityScoreRepository: QualityScoreRepository,
    private readonly driftEventRepository: DriftEventRepository,
    private readonly driftStateRepository: DriftStateRepository,
    private readonly driftStateCache: DriftStateCacheService,
    private readonly alertEventRepository: AlertEventRepository,
    private readonly alertDeliveryService: AlertDeliveryService,
    /** Optional — WO-062's suppression system; existing call sites that don't pass it never suppress a drift alert (equivalent to "no snoozes ever configured"). */
    private readonly suppressionService?: AlertSuppressionService,
  ) {}

  /**
   * One evaluation for one agent. Returns null (not evaluated at all) if
   * the agent has no established baseline yet (AC: "only activates for
   * agents with established baselines") or there isn't enough real data
   * on either side of the comparison this tick.
   */
  async evaluateAgent(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, now: Date = new Date(), pValueThreshold: number = DEFAULT_P_VALUE_THRESHOLD): Promise<DriftEvaluation | null> {
    const baseline = await this.qualityScoreRepository.findBaseline(client, tenantId, agentId);
    if (!baseline || !baseline.establishedAt) return null;

    const baselineHistory = await this.qualityScoreRepository.getScoreHistoryInRange(client, tenantId, agentId, baseline.calibrationStartedAt.toISOString(), baseline.establishedAt.toISOString());
    const recentSinceIso = new Date(now.getTime() - RECENT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const recentHistory = await this.qualityScoreRepository.getScoreHistory(client, tenantId, agentId, recentSinceIso);

    const baselineScores = baselineHistory.map((h) => h.compositeScore).filter((v): v is number => v !== null);
    const recentScores = recentHistory.map((h) => h.compositeScore).filter((v): v is number => v !== null);
    if (baselineScores.length === 0 || recentScores.length === 0) {
      this.logger.debug(`agent ${agentId}: insufficient scored history this tick (baseline=${baselineScores.length}, recent=${recentScores.length}) — skipping drift evaluation`);
      return null;
    }

    const ks = twoSampleKsTest(recentScores, baselineScores);
    const baselineMean = average(baselineScores);
    const currentMean = average(recentScores);
    const degradationMagnitude = baselineMean - currentMean; // positive = degraded, negative = improved

    // AC: degradation-only filter — a statistically significant IMPROVEMENT is never flagged as drift.
    const isDriftingThisWindow = ks.pValue < pValueThreshold && currentMean < baselineMean;

    const priorState = (await this.driftStateCache.get(tenantId, agentId)) ?? (await this.driftStateRepository.find(client, tenantId, agentId));
    const priorCount = priorState?.consecutiveDriftCount ?? 0;
    const newCount = isDriftingThisWindow ? priorCount + 1 : 0;

    await this.driftStateCache.set(tenantId, agentId, { consecutiveDriftCount: newCount, lastKsStatistic: ks.statistic, lastPValue: ks.pValue });
    await this.driftStateRepository.upsert(client, tenantId, agentId, newCount, ks.statistic, ks.pValue, now);

    const affectedComponents = componentDeltas(baselineHistory, recentHistory);
    const driftStatus: DriftStatus = newCount >= CONSECUTIVE_WINDOWS_REQUIRED ? "significant_drift" : newCount > 0 ? "drifting" : "no_drift";
    // Alert exactly once when the streak CROSSES the threshold — not on every subsequent tick the streak stays elevated (that would spam an alert every hour for the life of one drift episode).
    const shouldAlert = newCount === CONSECUTIVE_WINDOWS_REQUIRED;

    const evaluation: DriftEvaluation = {
      driftStatus,
      ksStatistic: ks.statistic,
      pValue: ks.pValue,
      baselineMean,
      currentMean,
      degradationMagnitude,
      affectedComponents,
      consecutiveWindowCount: newCount,
      shouldAlert,
    };

    if (shouldAlert) {
      await this.raiseDriftAlert(client, tenantId, agentId, evaluation, now);
    }

    return evaluation;
  }

  private async raiseDriftAlert(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, evaluation: DriftEvaluation, now: Date): Promise<AlertEvent | null> {
    const suppressed = this.suppressionService ? await this.suppressionService.isAlertSuppressed(client, tenantId, agentId, DRIFT_METRIC_NAME, now) : false;
    if (suppressed) return null;

    const withinCooldown = await this.isWithinCooldown(client, tenantId, agentId, now);
    if (withinCooldown) return null;

    await this.driftEventRepository.create(client, tenantId, agentId, {
      ksStatistic: evaluation.ksStatistic,
      pValue: evaluation.pValue,
      baselineMean: evaluation.baselineMean,
      currentMean: evaluation.currentMean,
      degradationMagnitude: evaluation.degradationMagnitude,
      affectedComponents: evaluation.affectedComponents,
      consecutiveWindowCount: evaluation.consecutiveWindowCount,
    });

    const severity: AlertSeverity = evaluation.pValue < 0.01 || evaluation.degradationMagnitude >= 20 ? "critical" : "warning";

    const event = await this.alertEventRepository.create(client, tenantId, agentId, {
      metricName: DRIFT_METRIC_NAME,
      thresholdValue: 0.05,
      actualValue: evaluation.pValue,
      severity,
      breachTimestamp: now,
      detectionMethod: "drift",
      statisticalEvidence: {
        expectedValue: evaluation.baselineMean,
        actualValue: evaluation.currentMean,
        deviationSigma: evaluation.ksStatistic,
        algorithmUsed: "ks_test",
      },
    });

    await this.alertDeliveryService.deliver(event).catch((err) => this.logger.warn(`drift alert delivery failed for event ${event.id}: ${err instanceof Error ? err.message : err}`));
    return event;
  }

  private async isWithinCooldown(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, now: Date): Promise<boolean> {
    const mostRecent = await this.alertEventRepository.findMostRecent(client, tenantId, agentId, DRIFT_METRIC_NAME);
    if (!mostRecent) return false;
    const elapsedSeconds = (now.getTime() - mostRecent.breachTimestamp.getTime()) / 1000;
    return elapsedSeconds < ALERT_COOLDOWN_SECONDS;
  }
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function componentDeltas(baselineHistory: Array<{ toolCallScore: number | null; reasoningScore: number | null; consistencyScore: number | null }>, recentHistory: typeof baselineHistory): ComponentDeltas {
  const avgOf = (rows: typeof baselineHistory, key: "toolCallScore" | "reasoningScore" | "consistencyScore") => {
    const values = rows.map((r) => r[key]).filter((v): v is number => v !== null);
    return values.length === 0 ? null : average(values);
  };

  const delta = (key: "toolCallScore" | "reasoningScore" | "consistencyScore") => {
    const baselineAvg = avgOf(baselineHistory, key);
    const recentAvg = avgOf(recentHistory, key);
    return baselineAvg === null || recentAvg === null ? null : baselineAvg - recentAvg;
  };

  return { toolCall: delta("toolCallScore"), reasoning: delta("reasoningScore"), consistency: delta("consistencyScore") };
}
