import type { AgentLifecycleStatus } from "./dto/list-agents-query.dto";

// Canonical transition table (this WO's own acceptance criteria):
// Connecting->Active, Active->Paused, Active->Retired, Paused->Active,
// Paused->Retired, Retired->Decommissioned, Connecting->Decommissioned
// (failed connection attempts never reaching Active). Every other pair —
// notably Decommissioned->anything and Paused->Connecting — is invalid
// and absent here rather than special-cased as a rejection list.
export const AGENT_LIFECYCLE_TRANSITIONS: Record<AgentLifecycleStatus, readonly AgentLifecycleStatus[]> = {
  connecting: ["active", "decommissioned"],
  active: ["paused", "retired"],
  paused: ["active", "retired"],
  retired: ["decommissioned"],
  decommissioned: [],
};

// A transition into either of these states must carry a justification —
// both are effectively irreversible (Retired can only ever move on to
// Decommissioned; Decommissioned has no outbound transitions at all), so
// an administrator's reasoning needs to survive in the audit trail.
export const JUSTIFICATION_REQUIRED_STATUSES: readonly AgentLifecycleStatus[] = ["retired", "decommissioned"];

export function isValidTransition(from: AgentLifecycleStatus, to: AgentLifecycleStatus): boolean {
  return AGENT_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function validTransitionsFrom(from: AgentLifecycleStatus): readonly AgentLifecycleStatus[] {
  return AGENT_LIFECYCLE_TRANSITIONS[from];
}
