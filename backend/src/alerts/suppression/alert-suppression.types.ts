export const SNOOZE_DURATIONS = ["1h", "4h", "24h", "7d"] as const;
export type SnoozeDuration = (typeof SNOOZE_DURATIONS)[number];

export const SNOOZE_DURATION_MS: Record<SnoozeDuration, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export const FEEDBACK_TYPES = ["confirmed", "false_positive"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export interface FalsePositiveFeedback {
  id: string;
  tenantId: string;
  agentId: string;
  alertEventId: string;
  metricName: string;
  feedbackType: FeedbackType;
  createdBy: string | null;
  createdAt: Date;
}

export interface AlertSnoozeConfig {
  id: string;
  tenantId: string;
  agentId: string;
  metricName: string;
  snoozedUntil: Date;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertAutoTuneState {
  id: string;
  tenantId: string;
  agentId: string;
  metricName: string;
  warningMultiplier: number;
  lastTunedAt: Date | null;
  feedbackCursor: Date;
}

export interface PatternFeedbackCounts {
  falsePositiveCount: number;
  confirmedCount: number;
}

export interface SuppressionMetrics {
  falsePositiveRate: number;
  suppressedCount: number;
  feedbackCount: number;
  autoTunedCount: number;
}

/** AC: auto-tune widens the warning threshold by 20% per tuning pass, never exceeding 2x the agent's originally configured warning threshold. */
export const AUTO_TUNE_STEP_MULTIPLIER = 1.2;
export const AUTO_TUNE_MAX_MULTIPLIER = 2.0;
/** AC: "3+ false positive feedbacks within 7 days without any confirmed feedbacks" triggers auto-tuning. */
export const AUTO_TUNE_MIN_FALSE_POSITIVES = 3;
export const AUTO_TUNE_WINDOW_DAYS = 7;
