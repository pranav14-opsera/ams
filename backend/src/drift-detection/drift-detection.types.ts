export const DRIFT_STATUSES = ["no_drift", "drifting", "significant_drift"] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];

/** AC: 3 consecutive 1-hour drifting windows before a real alert fires. */
export const CONSECUTIVE_WINDOWS_REQUIRED = 3;
export const EVALUATION_WINDOW_HOURS = 1;
export const RECENT_LOOKBACK_HOURS = 24;
export const DEFAULT_P_VALUE_THRESHOLD = 0.05;

export interface DriftDetectionState {
  id: string;
  tenantId: string;
  agentId: string;
  consecutiveDriftCount: number;
  lastEvaluatedAt: Date | null;
  lastKsStatistic: number | null;
  lastPValue: number | null;
}

export interface ComponentDeltas {
  toolCall: number | null;
  reasoning: number | null;
  consistency: number | null;
}

export interface DriftEvaluation {
  driftStatus: DriftStatus;
  ksStatistic: number;
  pValue: number;
  baselineMean: number;
  currentMean: number;
  degradationMagnitude: number;
  affectedComponents: ComponentDeltas;
  consecutiveWindowCount: number;
  /** true only when this evaluation crossed the 3-consecutive-window threshold AND represents genuine degradation (current < baseline) — the caller's own signal for "an alert should be raised now". */
  shouldAlert: boolean;
}

export interface DriftEvent {
  id: string;
  tenantId: string;
  agentId: string;
  detectedAt: Date;
  ksStatistic: number;
  pValue: number;
  baselineMean: number;
  currentMean: number;
  degradationMagnitude: number;
  affectedComponents: ComponentDeltas;
  consecutiveWindowCount: number;
}
