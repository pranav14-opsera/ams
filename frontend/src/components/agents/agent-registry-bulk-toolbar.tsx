"use client";

import { Button } from "@/components/ui/button";

export interface AgentRegistryBulkToolbarProps {
  selectedCount: number;
  onClearSelection: () => void;
}

/**
 * AC: "selected count is displayed in a toolbar" with "placeholder action
 * buttons for lifecycle operations" — the actual bulk pause/retire/etc
 * wiring (against the already-existing BulkLifecycleService/
 * POST /api/v1/agents/bulk-lifecycle) is WO-081's own scope per this WO's
 * own traceability notes; these buttons are intentionally inert beyond
 * this page (disabled with a title explaining why) rather than a
 * half-wired call into an endpoint this page was never asked to drive.
 */
export function AgentRegistryBulkToolbar({ selectedCount, onClearSelection }: AgentRegistryBulkToolbarProps) {
  if (selectedCount === 0) return null;

  return (
    <div role="toolbar" aria-label="Bulk agent actions" className="border-border bg-muted flex items-center gap-3 rounded-md border px-4 py-2 text-sm">
      <span role="status">
        {selectedCount} agent{selectedCount === 1 ? "" : "s"} selected
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          title="Bulk lifecycle actions are wired up in a follow-up story (WO-081)"
        >
          Pause
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          title="Bulk lifecycle actions are wired up in a follow-up story (WO-081)"
        >
          Retire
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClearSelection}>
          Clear selection
        </Button>
      </div>
    </div>
  );
}
