import { Badge } from "@/components/ui/badge";
import type { AgentLifecycleStatus } from "@/types/dashboard";

// AC: "color-coded status indicator: Connecting (yellow/amber), Active
// (green), Paused (amber/orange), Retired (gray), Decommissioned (red)."
const STATUS_LABEL: Record<AgentLifecycleStatus, string> = {
  connecting: "Connecting",
  active: "Active",
  paused: "Paused",
  retired: "Retired",
  decommissioned: "Decommissioned",
};

export interface AgentStatusBadgeProps {
  status: AgentLifecycleStatus;
}

/** AC: a visually distinct, color-coded badge for each of the 5 agent lifecycle statuses. Reuses ui/Badge's own variant system (badge.tsx) rather than a bespoke color mapping. */
export function AgentStatusBadge({ status }: AgentStatusBadgeProps) {
  return <Badge variant={status}>{STATUS_LABEL[status]}</Badge>;
}
