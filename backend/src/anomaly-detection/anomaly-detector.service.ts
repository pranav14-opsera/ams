import { Injectable, Logger } from "@nestjs/common";
import { ewmaDeviationSigma, updateEwma, type EwmaState } from "../algorithms/ewma";
import { computeZScore, isAnomalous } from "../algorithms/zscore";
import { AlertDeliveryService } from "../alerts/alert-delivery.service";
import { AlertEventRepository } from "../alerts/alert-event.repository";
import type { AlertEvent, AlertSeverity } from "../alerts/alert-threshold.types";
import { AnomalyBaselineRepository } from "./anomaly-baseline.repository";
import { ANOMALY_METRIC_NAMES, SIGMA_THRESHOLD_BY_SENSITIVITY, type AnomalyMetricName, type DriftDetectionConfig } from "./anomaly-detection.types";
import { CalibrationService } from "./calibration.service";
import { DriftDetectionConfigRepository } from "./drift-detection-config.repository";
import { EwmaStateCacheService } from "./ewma-state-cache.service";

const EWMA_LAMBDA = 0.2; // moderate smoothing — reacts within a handful of ticks without being noise-sensitive on a single spike
const ANOMALY_COOLDOWN_SECONDS = 300; // same cooldown window as WO-059's own threshold alerts

@Injectable()
export class AnomalyDetectorService {
  private readonly logger = new Logger(AnomalyDetectorService.name);

  constructor(
    private readonly driftConfigRepository: DriftDetectionConfigRepository,
    private readonly baselineRepository: AnomalyBaselineRepository,
    private readonly calibrationService: CalibrationService,
    private readonly ewmaCache: EwmaStateCacheService,
    private readonly eventRepository: AlertEventRepository,
    private readonly alertDeliveryService: AlertDeliveryService,
  ) {}

  async evaluateTenant(tenantId: string, now: Date = new Date()): Promise<AlertEvent[]> {
    const configs = await this.driftConfigRepository.findAllEnabledForTenant(undefined, tenantId);
    if (configs.length === 0) return [];

    const generatedEvents: AlertEvent[] = [];
    for (const config of configs) {
      for (const metricName of ANOMALY_METRIC_NAMES) {
        const event = await this.evaluateOne(config, metricName, now);
        if (event) generatedEvents.push(event);
      }
    }
    return generatedEvents;
  }

  private async evaluateOne(config: DriftDetectionConfig, metricName: AnomalyMetricName, now: Date): Promise<AlertEvent | null> {
    const { tenantId, agentId } = config;

    await this.calibrationService.checkAndCompleteCalibration(undefined, tenantId, agentId, metricName, now);
    const baseline = await this.baselineRepository.findByAgentAndMetric(undefined, tenantId, agentId, metricName);
    if (!baseline || !baseline.calibrationCompletedAt) return null; // AC: no detection during (or before) calibration

    const latestValue = await this.calibrationService.getLatestMetricValue(undefined, tenantId, agentId, metricName);
    if (latestValue === null) return null; // no fresh data this tick

    const sigmaThreshold = SIGMA_THRESHOLD_BY_SENSITIVITY[config.sensitivity];

    return metricName === "token_consumption"
      ? this.evaluateZScore(tenantId, agentId, metricName, latestValue, baseline.baselineMean!, baseline.baselineVariance!, sigmaThreshold, now)
      : this.evaluateEwma(tenantId, agentId, metricName, latestValue, baseline, sigmaThreshold, now);
  }

  private async evaluateZScore(
    tenantId: string,
    agentId: string,
    metricName: AnomalyMetricName,
    latestValue: number,
    baselineMean: number,
    baselineVariance: number,
    sigmaThreshold: number,
    now: Date,
  ): Promise<AlertEvent | null> {
    const result = computeZScore(latestValue, baselineMean, baselineVariance);
    if (!isAnomalous(result, sigmaThreshold)) return null;

    return this.raiseAnomaly(tenantId, agentId, metricName, {
      expectedValue: baselineMean,
      actualValue: latestValue,
      deviationSigma: result.zScore,
      algorithmUsed: "zscore",
      sigmaThreshold,
      now,
    });
  }

  private async evaluateEwma(
    tenantId: string,
    agentId: string,
    metricName: AnomalyMetricName,
    latestValue: number,
    baseline: { ewmaMean: number | null; ewmaVariance: number | null; observationCount: number },
    sigmaThreshold: number,
    now: Date,
  ): Promise<AlertEvent | null> {
    const cached = await this.ewmaCache.get(tenantId, agentId, metricName);
    const currentState: EwmaState = cached ?? { mean: baseline.ewmaMean ?? latestValue, variance: baseline.ewmaVariance ?? 0, observationCount: baseline.observationCount };

    // Evaluate the new observation against what was EXPECTED before seeing it, then fold it into the running state for next tick.
    const sigma = ewmaDeviationSigma(currentState, latestValue);
    const expectedValue = currentState.mean;
    const updatedState = updateEwma(currentState, latestValue, EWMA_LAMBDA);

    await this.ewmaCache.set(tenantId, agentId, metricName, updatedState);
    await this.baselineRepository.updateEwmaState(undefined, tenantId, agentId, metricName, updatedState.mean, updatedState.variance, updatedState.observationCount);

    // ewmaDeviationSigma returns exactly 0 for "at the mean" (never anomalous, even with zero variance)
    // and +Infinity for "any deviation from a perfectly stable baseline" (always anomalous) — a plain
    // magnitude comparison against the threshold handles both edge cases correctly with no special-casing.
    if (Math.abs(sigma) < sigmaThreshold) return null;

    return this.raiseAnomaly(tenantId, agentId, metricName, { expectedValue, actualValue: latestValue, deviationSigma: sigma, algorithmUsed: "ewma", sigmaThreshold, now });
  }

  private async raiseAnomaly(
    tenantId: string,
    agentId: string,
    metricName: AnomalyMetricName,
    evidence: { expectedValue: number; actualValue: number; deviationSigma: number; algorithmUsed: "ewma" | "zscore"; sigmaThreshold: number; now: Date },
  ): Promise<AlertEvent | null> {
    const withinCooldown = await this.isWithinCooldown(tenantId, agentId, metricName, evidence.now);
    if (withinCooldown) return null;

    const severity: AlertSeverity = Math.abs(evidence.deviationSigma) >= evidence.sigmaThreshold + 1 ? "critical" : "warning";

    const event = await this.eventRepository.create(undefined, tenantId, agentId, {
      metricName,
      thresholdValue: evidence.sigmaThreshold,
      actualValue: evidence.actualValue,
      severity,
      breachTimestamp: evidence.now,
      detectionMethod: "anomaly",
      statisticalEvidence: {
        expectedValue: evidence.expectedValue,
        actualValue: evidence.actualValue,
        deviationSigma: evidence.deviationSigma,
        algorithmUsed: evidence.algorithmUsed,
      },
    });

    await this.alertDeliveryService.deliver(event).catch((err) => this.logger.warn(`anomaly alert delivery failed for event ${event.id}: ${err instanceof Error ? err.message : err}`));
    return event;
  }

  private async isWithinCooldown(tenantId: string, agentId: string, metricName: AnomalyMetricName, now: Date): Promise<boolean> {
    const mostRecent = await this.eventRepository.findMostRecent(undefined, tenantId, agentId, metricName);
    if (!mostRecent) return false;
    const elapsedSeconds = (now.getTime() - mostRecent.breachTimestamp.getTime()) / 1000;
    return elapsedSeconds < ANOMALY_COOLDOWN_SECONDS;
  }
}
