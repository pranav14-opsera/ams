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

export interface BulkConfirmationAgentSummary {
  id: string;
  name: string;
  status: AgentLifecycleStatus;
}

export interface BulkConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: LifecycleAction;
  agents: BulkConfirmationAgentSummary[];
  onConfirm: () => void;
  isPending?: boolean;
}

/**
 * AC 7: "Bulk action confirmation dialog shows the count and list of
 * affected agents, the target action, and any warnings about in-flight
 * operations." Same AlertDialog primitive as the individual
 * LifecycleConfirmationDialog (Escape-dismissible, focus-trapped); the
 * in-flight warning shows whenever ANY selected agent is Active and the
 * action is "pause" (a bulk pause can silently include a mix of statuses
 * the toolbar's own intersection already filtered down to a common action,
 * but "pause" is only ever common when every selected agent is Active).
 */
export function BulkConfirmationDialog({ open, onOpenChange, action, agents, onConfirm, isPending = false }: BulkConfirmationDialogProps) {
  const showInFlightWarning = agents.some((a) => requiresInFlightWarning(a.status, action.name));

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {action.label} {agents.length} agent{agents.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <ul className="max-h-40 list-inside list-disc overflow-y-auto text-sm">
                {agents.map((a) => (
                  <li key={a.id}>{a.name}</li>
                ))}
              </ul>
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
