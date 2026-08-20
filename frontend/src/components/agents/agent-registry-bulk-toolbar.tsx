"use client";

import { Loader2, Pause, Play, Power, Trash2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LIFECYCLE_ACTION_NAMES, getCommonValidActions, type LifecycleAction, type LifecycleActionName } from "@/lib/agent-lifecycle-state-machine";
import type { AgentLifecycleStatus } from "@/types/dashboard";

const ALL_ACTIONS: Record<LifecycleActionName, LifecycleAction> = {
  pause: { name: "pause", label: "Pause", targetStatus: "paused" },
  resume: { name: "resume", label: "Resume", targetStatus: "active" },
  retire: { name: "retire", label: "Retire", targetStatus: "retired" },
  decommission: { name: "decommission", label: "Decommission", targetStatus: "decommissioned" },
};

const ACTION_ICON: Record<LifecycleActionName, LucideIcon> = {
  pause: Pause,
  resume: Play,
  retire: Trash2,
  decommission: Power,
};

export interface BulkToolbarAgentSummary {
  id: string;
  name: string;
  status: AgentLifecycleStatus;
}

export interface AgentRegistryBulkToolbarProps {
  selectedAgents: BulkToolbarAgentSummary[];
  onClearSelection: () => void;
  /** AC: "Selecting a lifecycle action opens a confirmation dialog." The toolbar itself only computes which actions are valid across the whole selection and reports the chosen one — the page owns the confirmation dialog and the actual bulk-lifecycle call, same split as AgentActionMenu's own onSelectAction. */
  onAction: (action: LifecycleAction) => void;
  isPending?: boolean;
}

/**
 * WO-081: replaces WO-079's own disabled placeholder Pause/Retire buttons
 * with real, context-sensitive bulk actions. AC: "a bulk action toolbar
 * appears with available actions (only actions valid for ALL selected
 * agents are enabled)" — computed as the intersection of each selected
 * agent's own valid-action set (getCommonValidActions).
 */
export function AgentRegistryBulkToolbar({ selectedAgents, onClearSelection, onAction, isPending = false }: AgentRegistryBulkToolbarProps) {
  const selectedCount = selectedAgents.length;
  if (selectedCount === 0) return null;

  const commonActions = getCommonValidActions(selectedAgents.map((a) => a.status));
  const hasCommonActions = commonActions.length > 0;
  const commonNames = new Set(commonActions.map((a) => a.name));

  return (
    <div role="toolbar" aria-label="Bulk agent actions" className="border-border bg-muted flex flex-col gap-2 rounded-md border px-4 py-2 text-sm">
      <div className="flex items-center gap-3">
        <span role="status">
          {selectedCount} agent{selectedCount === 1 ? "" : "s"} selected
        </span>
        <div className="ml-auto flex items-center gap-2">
          {isPending && (
            <span role="status" className="text-muted-foreground flex items-center gap-1">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Applying…
            </span>
          )}
          {LIFECYCLE_ACTION_NAMES.map((name) => {
            const action = ALL_ACTIONS[name];
            const Icon = ACTION_ICON[name];
            const enabled = commonNames.has(name) && !isPending;
            return (
              <Button
                key={name}
                type="button"
                variant="outline"
                size="sm"
                disabled={!enabled}
                title={enabled ? undefined : "Not a valid action for every selected agent"}
                onClick={() => onAction(action)}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {action.label}
              </Button>
            );
          })}
          <Button type="button" variant="ghost" size="sm" onClick={onClearSelection} disabled={isPending}>
            Clear selection
          </Button>
        </div>
      </div>
      {/* edge_case: "Bulk selection with agents in incompatible states: if selected agents span states with no common valid actions, the bulk action toolbar shows a message 'No common actions available for selected agents' with all action buttons disabled." */}
      {!hasCommonActions && <p role="status">No common actions available for selected agents</p>}
    </div>
  );
}
