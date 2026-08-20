"use client";

import { EllipsisVertical, Loader2, Pause, Play, Power, Trash2, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getValidActions, type LifecycleAction, type LifecycleActionName } from "@/lib/agent-lifecycle-state-machine";
import type { AgentLifecycleStatus } from "@/types/dashboard";

const ACTION_ICON: Record<LifecycleActionName, LucideIcon> = {
  pause: Pause,
  resume: Play,
  retire: Trash2,
  decommission: Power,
};

export interface AgentActionMenuProps {
  agentId: string;
  agentName: string;
  status: AgentLifecycleStatus;
  onSelectAction: (action: LifecycleAction) => void;
  /** AC: "shows a loading spinner on the affected row during transition" — disables the trigger and swaps the kebab icon for a spinner while a transition for this specific row is in flight. */
  isTransitioning?: boolean;
}

/**
 * AC: "Each agent row... displays a context-sensitive action menu (dropdown
 * or kebab menu) showing only valid lifecycle transitions for the agent's
 * current state." Connecting and Decommissioned agents get no menu at all
 * (getValidActions returns an empty list for both) rather than a menu
 * button that opens onto nothing.
 */
export function AgentActionMenu({ agentId, agentName, status, onSelectAction, isTransitioning = false }: AgentActionMenuProps) {
  const actions = getValidActions(status);

  if (isTransitioning) {
    return (
      <span role="status" aria-label={`${agentName} is transitioning`} className="text-muted-foreground inline-flex size-8 items-center justify-center">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      </span>
    );
  }

  if (actions.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${agentName}`}
          data-agent-id={agentId}
          className="hover:bg-muted focus-visible:ring-2 focus-visible:outline-none inline-flex size-8 items-center justify-center rounded-md"
        >
          <EllipsisVertical aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => {
          const Icon = ACTION_ICON[action.name];
          return (
            <DropdownMenuItem key={action.name} onSelect={() => onSelectAction(action)}>
              <Icon aria-hidden="true" className="size-4" />
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
