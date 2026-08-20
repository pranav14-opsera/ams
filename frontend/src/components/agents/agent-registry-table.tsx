"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { AgentActionMenu } from "@/components/agents/agent-action-menu";
import { AgentStatusBadge } from "@/components/agents/agent-status-badge";
import { FrameworkBadge } from "@/components/agents/framework-badge";
import { cn } from "@/lib/utils";
import type { LifecycleAction } from "@/lib/agent-lifecycle-state-machine";
import type { AgentRegistryEntry, AgentRegistrySort, AgentRegistrySortField } from "@/types/dashboard";

const COLUMNS: Array<{ field: AgentRegistrySortField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "framework", label: "Framework" },
  { field: "status", label: "Status" },
  { field: "lastSeen", label: "Last Seen" },
];

function formatLastSeen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export interface AgentRegistryTableProps {
  agents: AgentRegistryEntry[];
  sort: AgentRegistrySort;
  onSortChange: (sort: AgentRegistrySort) => void;
  selectedIds: Set<string>;
  onToggleRow: (agentId: string) => void;
  onToggleAllOnPage: () => void;
  /** AC: "Selecting a lifecycle action opens a confirmation dialog" — the table only surfaces the chosen action per row; the page owns the dialog and the API call. */
  onSelectAction?: (agent: AgentRegistryEntry, action: LifecycleAction) => void;
  /** AC: "loading spinner on the affected row during transition." */
  transitioningIds?: Set<string>;
}

/**
 * AC: 6-column sortable/filterable/paginated data table (filtering and
 * pagination live in the caller/sibling components — this component owns
 * sort headers, row selection, and the ARIA-live status announcements).
 * Plain accessible HTML `<table>` rather than a table library — no
 * @tanstack/react-table dependency exists in this codebase yet, and its
 * own established convention elsewhere (HealthFilterBar, UsageFilterPanel)
 * is plain accessible HTML over a heavy component library.
 */
export function AgentRegistryTable({ agents, sort, onSortChange, selectedIds, onToggleRow, onToggleAllOnPage, onSelectAction, transitioningIds }: AgentRegistryTableProps) {
  const allOnPageSelected = agents.length > 0 && agents.every((a) => selectedIds.has(a.id));
  const someOnPageSelected = agents.some((a) => selectedIds.has(a.id));

  function handleSort(field: AgentRegistrySortField) {
    if (sort.sortBy === field) {
      onSortChange({ sortBy: field, sortOrder: sort.sortOrder === "asc" ? "desc" : "asc" });
    } else {
      onSortChange({ sortBy: field, sortOrder: "asc" });
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-border border-b">
            <th scope="col" className="w-10 px-3 py-2">
              <input
                type="checkbox"
                aria-label="Select all agents on this page"
                checked={allOnPageSelected}
                ref={(el) => {
                  if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected;
                }}
                onChange={onToggleAllOnPage}
              />
            </th>
            {COLUMNS.map((column) => (
              <th key={column.field} scope="col" className="px-3 py-2 font-medium">
                <button
                  type="button"
                  className="flex items-center gap-1 hover:underline focus-visible:ring-2 focus-visible:outline-none"
                  onClick={() => handleSort(column.field)}
                  aria-label={`Sort by ${column.label}${sort.sortBy === column.field ? `, currently sorted ${sort.sortOrder === "asc" ? "ascending" : "descending"}` : ""}`}
                >
                  {column.label}
                  {sort.sortBy === column.field &&
                    (sort.sortOrder === "asc" ? <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />)}
                </button>
              </th>
            ))}
            <th scope="col" className="px-3 py-2 font-medium">
              Team
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id} className={cn("border-border border-b", selectedIds.has(agent.id) && "bg-muted")}>
              <td className="px-3 py-2">
                <input type="checkbox" aria-label={`Select ${agent.name}`} checked={selectedIds.has(agent.id)} onChange={() => onToggleRow(agent.id)} />
              </td>
              <td className="px-3 py-2 font-medium">{agent.name}</td>
              <td className="px-3 py-2">
                <FrameworkBadge framework={agent.framework} />
              </td>
              <td className="px-3 py-2">
                {/* AC: ARIA live region announces status changes to screen readers when an agent's status updates in real time — wrapping the badge directly means a screen reader announces the new text the moment a merged WebSocket update changes it, with no separate "just changed" bookkeeping needed. */}
                <div aria-live="polite" aria-atomic="true">
                  <AgentStatusBadge status={agent.status} />
                </div>
              </td>
              <td className="px-3 py-2">{agent.team?.name ?? "—"}</td>
              <td className="px-3 py-2 text-muted-foreground">{formatLastSeen(agent.lastSeen)}</td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-3">
                  <a href={`/agents/${agent.id}`} className="text-primary text-sm underline">
                    View
                  </a>
                  {onSelectAction && (
                    <AgentActionMenu
                      agentId={agent.id}
                      agentName={agent.name}
                      status={agent.status}
                      isTransitioning={transitioningIds?.has(agent.id) ?? false}
                      onSelectAction={(action) => onSelectAction(agent, action)}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {agents.length === 0 && <p className="text-muted-foreground px-3 py-6 text-sm">No agents match the current filters.</p>}
    </div>
  );
}
