"use client";

import { AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { IN_FLIGHT_WARNING_MESSAGE, requiresInFlightWarning, type LifecycleAction } from "@/lib/agent-lifecycle-state-machine";
import type { AgentLifecycleStatus } from "@/types/dashboard";

const STATUS_LABEL: Record<AgentLifecycleStatus, string> = {
  connecting: "Connecting",
  active: "Active",
  paused: "Paused",
  retired: "Retired",
  decommissioned: "Decommissioned",
};

export interface LifecycleConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: LifecycleAction;
  agentName: string;
  currentStatus: AgentLifecycleStatus;
  onConfirm: () => void;
  isPending?: boolean;
}

/**
 * AC: "displays the action name, agent name, current and target status, and
 * conditionally shows an in-flight operations warning when pausing an
 * Active agent, with Confirm and Cancel buttons." Built on shadcn/ui
 * AlertDialog (Radix's AlertDialog primitive) rather than the plain
 * FocusTrap wrapper — this is exactly the "confirm a destructive/stateful
 * action" shape AlertDialog exists for, and it gets Escape-to-dismiss +
 * focus trapping + focus restoration for free (see ui/alert-dialog.tsx).
 */
export function LifecycleConfirmationDialog({ open, onOpenChange, action, agentName, currentStatus, onConfirm, isPending = false }: LifecycleConfirmationDialogProps) {
  const showInFlightWarning = requiresInFlightWarning(currentStatus, action.name);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{action.label} agent?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>
                <span className="font-medium">{agentName}</span> will move from <span className="font-medium">{STATUS_LABEL[currentStatus]}</span> to{" "}
                <span className="font-medium">{STATUS_LABEL[action.targetStatus]}</span>.
              </p>
              {showInFlightWarning && (
                <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{IN_FLIGHT_WARNING_MESSAGE}</span>
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={(event) => {
              // AC/edge_case: "debounce the confirmation dialog trigger and
              // disable the action button after first click to prevent
              // duplicate API calls" — prevent Radix's own default
              // close-on-click from racing a second click through before
              // `isPending` flips, and let the caller close the dialog
              // itself once the mutation settles instead.
              event.preventDefault();
              if (isPending) return;
              onConfirm();
            }}
          >
            {isPending ? "Confirming…" : "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
