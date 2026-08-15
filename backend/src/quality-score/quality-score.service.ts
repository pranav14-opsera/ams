import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { computeQualityScore, DEFAULT_QUALITY_SCORE_WEIGHTS, type QualityScoreResult, type QualityScoreWeights } from "../algorithms/quality-score";
import { QualityScoreRepository } from "./quality-score.repository";
import { colorForScore, QUALITY_SCORE_CALIBRATION_PERIOD_DAYS, type AgentQualityScoreSummary, type QualityScoreHistoryEntry } from "./quality-score.types";

const COMPUTATION_WINDOW_MS = 60 * 60 * 1000; // AC: "most recent 1-hour window of execution data"
const TREND_WINDOW_DAYS = 7;

@Injectable()
export class QualityScoreService {
  private readonly logger = new Logger(QualityScoreService.name);

  constructor(private readonly repository: QualityScoreRepository) {}

  private async resolveWeights(client: Pool | PoolClient | undefined, tenantId: string): Promise<QualityScoreWeights> {
    const config = await this.repository.getConfig(client, tenantId);
    if (!config) return DEFAULT_QUALITY_SCORE_WEIGHTS;
    return { toolCall: config.toolCallWeight, reasoning: config.reasoningWeight, consistency: config.consistencyWeight };
  }

  /** Computes (but does not store) a score for one agent from the most recent 1-hour window — split out from computeAndStoreScoreForAgent so callers (e.g. an API read) can get a live preview without writing a history row. */
  async computeScoreForAgent(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, now: Date = new Date()): Promise<QualityScoreResult> {
    const sinceIso = new Date(now.getTime() - COMPUTATION_WINDOW_MS).toISOString();
    const [toolCallSuccessRate, reasoningAccuracy, outputConsistency] = await Promise.all([
      this.repository.getToolCallSuccessRate(client, tenantId, agentId, sinceIso),
      this.repository.getReasoningAccuracy(client, tenantId, agentId, sinceIso),
      this.repository.getOutputConsistency(client, tenantId, agentId, sinceIso),
    ]);
    const weights = await this.resolveWeights(client, tenantId);
    return computeQualityScore({ toolCallSuccessRate, reasoningAccuracy, outputConsistency }, weights);
  }

  async computeAndStoreScoreForAgent(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, now: Date = new Date()): Promise<QualityScoreHistoryEntry> {
    const result = await this.computeScoreForAgent(client, tenantId, agentId, now);
    return this.repository.storeScore(client, tenantId, agentId, result, now);
  }

  async startCalibration(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<void> {
    await this.repository.ensureBaselineStarted(client, tenantId, agentId);
  }

  /**
   * AC: after the 7-day calibration period, the baseline is the MEDIAN of
   * all 5-minute scores accumulated so far — a no-op if already
   * established, still within the window, or there's no baseline record
   * at all (calibration was never started for this agent).
   */
  async checkAndEstablishBaseline(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, now: Date = new Date()): Promise<boolean> {
    const baseline = await this.repository.findBaseline(client, tenantId, agentId);
    if (!baseline || baseline.establishedAt) return false;

    const elapsedMs = now.getTime() - baseline.calibrationStartedAt.getTime();
    if (elapsedMs < QUALITY_SCORE_CALIBRATION_PERIOD_DAYS * 24 * 60 * 60 * 1000) return false;

    const { median, sampleCount } = await this.repository.getMedianScoreSince(client, tenantId, agentId, baseline.calibrationStartedAt.toISOString());
    if (median === null || sampleCount === 0) {
      this.logger.warn(`agent ${agentId} has no scored history over its calibration window — deferring baseline establishment`);
      return false;
    }

    await this.repository.establishBaseline(client, tenantId, agentId, median);
    return true;
  }

  async getScoreHistory(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sinceIso: string): Promise<QualityScoreHistoryEntry[]> {
    return this.repository.getScoreHistory(client, tenantId, agentId, sinceIso);
  }

  async setWeights(client: Pool | PoolClient | undefined, tenantId: string, toolCall: number, reasoning: number, consistency: number): Promise<QualityScoreWeights> {
    const config = await this.repository.upsertConfig(client, tenantId, toolCall, reasoning, consistency);
    return { toolCall: config.toolCallWeight, reasoning: config.reasoningWeight, consistency: config.consistencyWeight };
  }

  /** AC: "current score, component scores, and historical trend data" for the API + dashboard display. */
  async getAgentSummary(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, now: Date = new Date()): Promise<AgentQualityScoreSummary> {
    const mostRecent = await this.repository.getMostRecentScore(client, tenantId, agentId);
    const baseline = await this.repository.findBaseline(client, tenantId, agentId);
    const trendSince = new Date(now.getTime() - TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const trendRows = await this.repository.getScoreHistory(client, tenantId, agentId, trendSince);

    const current = mostRecent
      ? {
          compositeScore: mostRecent.compositeScore,
          componentScores: { toolCall: mostRecent.toolCallScore, reasoning: mostRecent.reasoningScore, consistency: mostRecent.consistencyScore },
          sampleCount: mostRecent.sampleCount,
          computedAt: mostRecent.computedAt.toISOString(),
        }
      : null;

    return {
      agentId,
      current,
      colorIndicator: current ? colorForScore(current.compositeScore) : null,
      baseline: baseline
        ? {
            score: baseline.baselineScore,
            establishedAt: baseline.establishedAt ? baseline.establishedAt.toISOString() : null,
            calibrating: !baseline.establishedAt,
            daysRemaining: baseline.establishedAt ? 0 : Math.max(0, Math.ceil(QUALITY_SCORE_CALIBRATION_PERIOD_DAYS - (now.getTime() - baseline.calibrationStartedAt.getTime()) / (24 * 60 * 60 * 1000))),
          }
        : null,
      sevenDayTrend: trendRows.map((row) => ({ computedAt: row.computedAt.toISOString(), compositeScore: row.compositeScore })),
    };
  }
}
