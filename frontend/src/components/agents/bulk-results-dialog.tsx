"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { FocusTrap } from "@/components/a11y/focus-trap";
import type { BulkLifecycleAgentResult } from "@/types/dashboard";

export interface BulkResultsDialogProps {
  open: boolean;
  onClose: () => void;
  /** agentId -> display name, from the selection the caller already held (the API's own per-agent result has no `agentName` field). */
  agentNames: Map<string, string>;
  results: BulkLifecycleAgentResult[];
  onRetryFailed?: (agentIds: string[]) => void;
  isRetrying?: boolean;
}

/**
 * AC: "displays per-agent results (success with green checkmark, failure
 * with red X and error message) and a summary count, with a 'Close' button
 * and optional 'Retry Failed' button." Built on FocusTrap + a plain
 * role="dialog" overlay (not AlertDialog) — this dialog's own content is a
 * scrollable list rather than a single confirm/cancel choice, closer to
 * MobileDrawer's own Dialog-primitive shape than AlertDialog's; FocusTrap
 * gives the same Tab-cycling/focus-restoration guarantee AlertDialogContent
 * gets from Radix, this codebase's own general-purpose primitive for
 * exactly this "not built on Radix Dialog/AlertDialog" case (see its own
 * docstring).
 */
export function BulkResultsDialog({ open, onClose, agentNames, results, onRetryFailed, isRetrying = false }: BulkResultsDialogProps) {
  // AC: "keyboard-dismissible (Escape key)" — a document-level listener
  // rather than an onKeyDown on the overlay div, since a div isn't a native
  // interactive element (jsx-a11y's own no-static-element-interactions
  // rule) and FocusTrap already constrains Tab/Shift+Tab to the dialog's
  // own focusable descendants, so a key handler on the div itself would
  // only ever catch bubbled events from those same descendants anyway.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const successes = results.filter((r) => r.status === "success");
  const failures = results.filter((r) => r.status === "failed");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <FocusTrap>
        <div role="dialog" aria-modal="true" aria-labelledby="bulk-results-dialog-title" className="bg-background border-border flex max-h-[80vh] w-full max-w-lg flex-col gap-4 rounded-md border p-6 shadow-lg">
          <div>
            <h2 id="bulk-results-dialog-title" className="text-lg font-semibold">
              Bulk operation results
            </h2>
            <p role="status" className="text-muted-foreground text-sm">
              {successes.length} succeeded, {failures.length} failed out of {results.length} agent{results.length === 1 ? "" : "s"}.
            </p>
          </div>

          <ul className="flex flex-col gap-2 overflow-y-auto">
            {results.map((result) => {
              const name = agentNames.get(result.agentId) ?? result.agentId;
              const isSuccess = result.status === "success";
              return (
                <li
                  key={result.agentId}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${isSuccess ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}
                >
                  {isSuccess ? (
                    <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green-700" />
                  ) : (
                    <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red-700" />
                  )}
                  <div className="flex flex-col">
                    <span className="font-medium">{name}</span>
                    {isSuccess ? (
                      <span className="text-green-900">
                        {result.previousStatus} → {result.newStatus}
                        {result.warning ? ` — ${result.warning}` : ""}
                      </span>
                    ) : (
                      <span className="text-red-900">{result.error ?? "Unknown error"}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-2 flex justify-end gap-2">
            {failures.length > 0 && onRetryFailed && (
              <Button
                type="button"
                variant="outline"
                disabled={isRetrying}
                onClick={() => onRetryFailed(failures.map((f) => f.agentId))}
              >
                {isRetrying ? "Retrying…" : "Retry Failed"}
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </FocusTrap>
    </div>
  );
}
