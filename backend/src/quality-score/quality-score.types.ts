import type { QualityScoreResult } from "../algorithms/quality-score";

export const QUALITY_SCORE_CALIBRATION_PERIOD_DAYS = 7;

export interface QualityScoreConfig {
  id: string;
  tenantId: string;
  toolCallWeight: number;
  reasoningWeight: number;
  consistencyWeight: number;
}

export interface QualityScoreHistoryEntry {
  id: string;
  tenantId: string;
  agentId: string;
  computedAt: Date;
  toolCallScore: number | null;
  reasoningScore: number | null;
  consistencyScore: number | null;
  compositeScore: number | null;
  sampleCount: number;
}

export interface QualityScoreBaseline {
  id: string;
  tenantId: string;
  agentId: string;
  baselineScore: number | null;
  calibrationStartedAt: Date;
  establishedAt: Date | null;
}

export type QualityScoreColor = "green" | "amber" | "red";

/** AC: green >= 80, amber 60-79, red < 60. */
export function colorForScore(score: number | null): QualityScoreColor | null {
  if (score === null) return null;
  if (score >= 80) return "green";
  if (score >= 60) return "amber";
  return "red";
}

export interface AgentQualityScoreSummary {
  agentId: string;
  current: (QualityScoreResult & { computedAt: string }) | null;
  colorIndicator: QualityScoreColor | null;
  baseline: { score: number | null; establishedAt: string | null; calibrating: boolean; daysRemaining: number } | null;
  sevenDayTrend: Array<{ computedAt: string; compositeScore: number | null }>;
}
