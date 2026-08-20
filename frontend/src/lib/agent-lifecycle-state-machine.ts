import type { AgentLifecycleStatus } from "@/types/dashboard";

/**
 * WO-081: client-side mirror of the server-side state machine
 * (backend/src/agents/lifecycle-state-machine.ts's own AGENT_LIFECYCLE_TRANSITIONS).
 *
 * The backend's own transition table additionally allows connecting->active
 * and connecting->decommissioned — but those two edges are never reached via
 * a human-triggered action button. connecting->active happens automatically
 * once ConnectionValidationService's background validation succeeds
 * (WO-080), and there is no admin-facing "force decommission a still-
 * connecting agent" action in this WO's own acceptance criteria ("Connecting
 * and Decommissioned show no lifecycle actions"). This module's table is
 * therefore deliberately the subset of the backend's transitions that are
 * exposed as explicit, named, user-triggered actions — every entry here is
 * still validated against (and must never diverge from) the backend's own
 * isValidTransition at the API boundary; a 409 Conflict is the safety net if
 * the two ever drift.
 */
export const LIFECYCLE_ACTION_NAMES = ["pause", "resume", "retire", "decommission"] as const;
export type LifecycleActionName = (typeof LIFECYCLE_ACTION_NAMES)[number];

export interface LifecycleAction {
  name: LifecycleActionName;
  /** Button/menu-item label (AC: "appropriate icon and label"). */
  label: string;
  /** The lifecycle status this action transitions the agent to — the wire value sent as `targetStatus` in the PATCH/POST bodies. */
  targetStatus: AgentLifecycleStatus;
}

const PAUSE: LifecycleAction = { name: "pause", label: "Pause", targetStatus: "paused" };
const RESUME: LifecycleAction = { name: "resume", label: "Resume", targetStatus: "active" };
const RETIRE: LifecycleAction = { name: "retire", label: "Retire", targetStatus: "retired" };
const DECOMMISSION: LifecycleAction = { name: "decommission", label: "Decommission", targetStatus: "decommissioned" };

// AC: "Active shows Pause/Retire, Paused shows Resume/Retire, Retired shows
// Decommission, Connecting and Decommissioned show no lifecycle actions."
const VALID_ACTIONS_BY_STATUS: Record<AgentLifecycleStatus, readonly LifecycleAction[]> = {
  connecting: [],
  active: [PAUSE, RETIRE],
  paused: [RESUME, RETIRE],
  retired: [DECOMMISSION],
  decommissioned: [],
};

/** The valid lifecycle actions available to a single agent given its current status. */
export function getValidActions(currentStatus: AgentLifecycleStatus): readonly LifecycleAction[] {
  return VALID_ACTIONS_BY_STATUS[currentStatus];
}

/** Whether `action` is a valid transition from `currentStatus`. */
export function isValidTransition(currentStatus: AgentLifecycleStatus, action: LifecycleActionName): boolean {
  return VALID_ACTIONS_BY_STATUS[currentStatus].some((a) => a.name === action);
}

/**
 * Bulk toolbar's own AC: "only actions valid for ALL selected agents are
 * enabled" — the intersection of each selected agent's own valid-action set,
 * by action name (not by object identity, since e.g. "retire" is a distinct
 * LifecycleAction object depending on whether it came from `active` or
 * `paused`'s own list, but names the same target/label either way).
 */
export function getCommonValidActions(currentStatuses: readonly AgentLifecycleStatus[]): readonly LifecycleAction[] {
  if (currentStatuses.length === 0) return [];
  let common: readonly LifecycleAction[] = getValidActions(currentStatuses[0]!);
  for (let i = 1; i < currentStatuses.length; i++) {
    const names = new Set(getValidActions(currentStatuses[i]!).map((a) => a.name));
    common = common.filter((a) => names.has(a.name));
    if (common.length === 0) return [];
  }
  return common;
}

/** AC: "For Active agents being paused" — the in-flight-operations warning only ever applies to this one edge. */
export function requiresInFlightWarning(currentStatus: AgentLifecycleStatus, action: LifecycleActionName): boolean {
  return currentStatus === "active" && action === "pause";
}

export const IN_FLIGHT_WARNING_MESSAGE =
  "This agent has operations that may be in progress. In-flight operations will complete gracefully before the agent fully pauses.";
