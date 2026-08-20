export type EnforcementMode = "cache" | "ledger";
export type MeteringDecision = "allowed" | "denied";

export interface MeteringRequest {
  tenantId: string;
  teamId: string | null;
  agentId: string | null;
  actionType: string;
  /** Number of billable units this operation represents — defaults to 1 (e.g., "one tool call"). */
  units?: number;
}

export interface MeteringResult {
  decision: MeteringDecision;
  enforcementMode: EnforcementMode;
  creditsConsumed: number;
  balanceAfter: number | null;
  latencyMs: number;
  reason?: string;
  /** WO-070 AC: "a structured denial response ... with a hard_cap_reached flag when balance is zero/negative" — true whenever a denial's own current balance is already at or below zero, regardless of which decision path produced the denial. */
  hardCapReached?: boolean;
}

/** AC: "5% of the hard cap" — the width of the near-cap danger zone (an absolute credit amount, not a percentage of the current balance) that triggers a synchronous ledger fallthrough instead of trusting the (eventually-consistent) cache. */
export const HARD_CAP_BUFFER_FRACTION = 0.05;
