"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AgentRegistryBulkToolbar } from "@/components/agents/agent-registry-bulk-toolbar";
import { AgentRegistryFilterBar } from "@/components/agents/agent-registry-filter-bar";
import { AgentRegistryPaginationBar } from "@/components/agents/agent-registry-pagination";
import { AgentRegistryTable } from "@/components/agents/agent-registry-table";
import { BulkConfirmationDialog } from "@/components/agents/bulk-confirmation-dialog";
import { BulkResultsDialog } from "@/components/agents/bulk-results-dialog";
import { LifecycleConfirmationDialog } from "@/components/agents/lifecycle-confirmation-dialog";
import { Button } from "@/components/ui/button";
import { useAgentHealthSocket } from "@/hooks/useAgentHealthSocket";
import { useAgentRegistryQuery } from "@/hooks/useAgentRegistryQuery";
import { BulkLifecycleError, useBulkLifecycleMutation } from "@/hooks/useBulkLifecycleMutation";
import { LifecycleTransitionError, useLifecycleTransitionMutation } from "@/hooks/useLifecycleTransitionMutation";
import type { LifecycleAction } from "@/lib/agent-lifecycle-state-machine";
import type { AgentRegistryEntry, AgentRegistryFilters, AgentRegistryPageSize, AgentRegistrySort, BulkLifecycleResponse } from "@/types/dashboard";

const DEFAULT_SORT: AgentRegistrySort = { sortBy: "name", sortOrder: "asc" };
const DEFAULT_PAGE_SIZE: AgentRegistryPageSize = 25;

function isHttpError(error: unknown): error is Error & { status?: number } {
  return error instanceof Error;
}

/**
 * WO-079: the Agent Registry page — a sortable/filterable/paginated table
 * of every tenant-scoped agent, with real-time lifecycle-status updates
 * pushed over the existing /ws/health channel. See implementation_steps'
 * own ordering: page shell -> badges -> data hook -> table -> bulk
 * selection -> WebSocket hook -> ARIA/keyboard -> fixtures -> tests ->
 * a11y -> error handling, all composed here.
 */
export default function AgentRegistryPage() {
  const router = useRouter();
  const [filters, setFilters] = useState<AgentRegistryFilters>({});
  const [sort, setSort] = useState<AgentRegistrySort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<AgentRegistryPageSize>(DEFAULT_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [transitioningIds, setTransitioningIds] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<{ agent: AgentRegistryEntry; action: LifecycleAction } | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<{ agents: AgentRegistryEntry[]; action: LifecycleAction } | null>(null);
  const [bulkResults, setBulkResults] = useState<{ agentNames: Map<string, string>; response: BulkLifecycleResponse } | null>(null);
  const [lastBulkAction, setLastBulkAction] = useState<LifecycleAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const query = useAgentRegistryQuery(filters, sort, page, pageSize);
  const { connectionState, statusUpdates } = useAgentHealthSocket();
  const lifecycleTransition = useLifecycleTransitionMutation();
  const bulkLifecycle = useBulkLifecycleMutation();

  // AC: API 401 responses redirect to the login page.
  useEffect(() => {
    if (isHttpError(query.error) && query.error.status === 401) {
      router.push("/login");
    }
  }, [query.error, router]);

  // Merges the WebSocket feed's per-agent status/lastSeen over the REST
  // page's own data — a real-time update to a row already on the current
  // page appears within the AC's 5-second window without a refetch.
  const mergedAgents: AgentRegistryEntry[] = useMemo(() => {
    const rows = query.data?.data ?? [];
    if (statusUpdates.size === 0) return rows;
    return rows.map((agent) => {
      const update = statusUpdates.get(agent.id);
      return update ? { ...agent, status: update.status, lastSeen: update.lastSeen } : agent;
    });
  }, [query.data, statusUpdates]);

  function handleFiltersChange(next: AgentRegistryFilters) {
    setFilters(next);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handleSortChange(next: AgentRegistrySort) {
    setSort(next);
    setSelectedIds(new Set());
  }

  function handlePageChange(next: number) {
    setPage(Math.max(1, next));
    setSelectedIds(new Set());
  }

  function handlePageSizeChange(next: AgentRegistryPageSize) {
    setPageSize(next);
    setPage(1);
    setSelectedIds(new Set());
  }

  function toggleRow(agentId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  function toggleAllOnPage() {
    const pageIds = mergedAgents.map((a) => a.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }

  function handleSelectAction(agent: AgentRegistryEntry, action: LifecycleAction) {
    setPendingAction({ agent, action });
  }

  function handleConfirmAction() {
    if (!pendingAction) return;
    const { agent, action } = pendingAction;
    setActionError(null);
    setTransitioningIds((prev) => new Set(prev).add(agent.id));
    lifecycleTransition.mutate(
      { agentId: agent.id, targetStatus: action.targetStatus },
      {
        onError: (err) => {
          // error_handling: 403 -> permission message; 409 -> the agent's
          // status changed underneath us, refresh from the server; anything
          // else -> the mutation's own message with a retry available via
          // reopening the action menu.
          if (err instanceof LifecycleTransitionError && err.status === 403) {
            setActionError("You don't have permission to change this agent's lifecycle status. Contact your administrator.");
          } else if (err instanceof LifecycleTransitionError && err.status === 409) {
            setActionError("Agent status has changed. Please review and try again.");
            void query.refetch();
          } else {
            setActionError(err instanceof Error ? err.message : "Failed to transition agent.");
          }
        },
        onSettled: () => {
          setTransitioningIds((prev) => {
            const next = new Set(prev);
            next.delete(agent.id);
            return next;
          });
          setPendingAction(null);
        },
      },
    );
  }

  function handleBulkAction(action: LifecycleAction) {
    const agents = mergedAgents.filter((a) => selectedIds.has(a.id));
    setPendingBulkAction({ agents, action });
  }

  function runBulkTransition(agents: Array<{ id: string; name: string }>, action: LifecycleAction) {
    const agentNames = new Map(agents.map((a) => [a.id, a.name]));
    setActionError(null);
    setLastBulkAction(action);
    setTransitioningIds((prev) => {
      const next = new Set(prev);
      for (const a of agents) next.add(a.id);
      return next;
    });
    bulkLifecycle.mutate(
      { agentIds: agents.map((a) => a.id), targetStatus: action.targetStatus },
      {
        onSuccess: (response) => {
          setBulkResults({ agentNames, response });
        },
        onError: (err) => {
          if (err instanceof BulkLifecycleError && err.status === 403) {
            setActionError("You don't have permission to change these agents' lifecycle status. Contact your administrator.");
          } else {
            setActionError(err instanceof Error ? err.message : "Bulk lifecycle operation failed.");
          }
        },
        onSettled: () => {
          setTransitioningIds((prev) => {
            const next = new Set(prev);
            for (const a of agents) next.delete(a.id);
            return next;
          });
        },
      },
    );
  }

  function handleConfirmBulkAction() {
    if (!pendingBulkAction) return;
    const { agents, action } = pendingBulkAction;
    runBulkTransition(agents, action);
    setPendingBulkAction(null);
  }

  // edge_case: "Bulk operation partial failure... results dialog... offer
  // individual retry" — re-runs the same bulk action (lastBulkAction) for
  // just the failed agent IDs, reusing their already-known names from the
  // results dialog's own agentNames map (the API's per-agent result never
  // carries agentName).
  function handleRetryFailed(agentIds: string[]) {
    if (!bulkResults || !lastBulkAction) return;
    const agents = agentIds.map((id) => ({ id, name: bulkResults.agentNames.get(id) ?? id }));
    setBulkResults(null);
    runBulkTransition(agents, lastBulkAction);
  }

  const is403 = isHttpError(query.error) && query.error.status === 403;
  const is500 = isHttpError(query.error) && !is403 && !(query.error.status === 401);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Agent Registry</h1>
          <p className="text-muted-foreground text-sm">All AI agents registered to your organization, with live status.</p>
        </div>
        <Button asChild>
          <Link href="/agents/register">Register New Agent</Link>
        </Button>
      </div>

      {connectionState === "reconnecting" && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Live updates paused — reconnecting…
        </p>
      )}
      {connectionState === "error" && (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Live status updates are currently unavailable. The table will still refresh when you change filters, sort, or page.
        </p>
      )}

      <AgentRegistryFilterBar filters={filters} onChange={handleFiltersChange} />

      {query.isLoading && <p role="status">Loading agent registry…</p>}

      {is403 && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          You don&apos;t have permission to view the agent registry. Contact an administrator if you believe this is a mistake.
        </p>
      )}

      {is500 && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>Something went wrong loading the agent registry. Please try again.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {actionError && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>{actionError}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setActionError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {query.isSuccess && query.data && (
        <>
          {query.data.pagination.total === 0 ? (
            <div className="border-border flex flex-col items-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
              <p className="text-muted-foreground text-sm">No agents match the current filters.</p>
              {!filters.framework?.length && !filters.status?.length && !filters.teamId && (
                <>
                  <p className="text-muted-foreground text-sm">No agents have been registered yet.</p>
                  <Button asChild>
                    <Link href="/agents/register">Register your first agent</Link>
                  </Button>
                </>
              )}
            </div>
          ) : (
            <>
              <AgentRegistryBulkToolbar
                selectedAgents={mergedAgents.filter((a) => selectedIds.has(a.id)).map((a) => ({ id: a.id, name: a.name, status: a.status }))}
                onClearSelection={() => setSelectedIds(new Set())}
                onAction={handleBulkAction}
                isPending={bulkLifecycle.isPending}
              />
              <AgentRegistryTable
                agents={mergedAgents}
                sort={sort}
                onSortChange={handleSortChange}
                selectedIds={selectedIds}
                onToggleRow={toggleRow}
                onToggleAllOnPage={toggleAllOnPage}
                onSelectAction={handleSelectAction}
                transitioningIds={transitioningIds}
              />
              <AgentRegistryPaginationBar pagination={query.data.pagination} onPageChange={handlePageChange} onPageSizeChange={handlePageSizeChange} />
            </>
          )}
        </>
      )}

      {pendingAction && (
        <LifecycleConfirmationDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingAction(null);
          }}
          action={pendingAction.action}
          agentName={pendingAction.agent.name}
          currentStatus={pendingAction.agent.status}
          onConfirm={handleConfirmAction}
          isPending={lifecycleTransition.isPending}
        />
      )}

      {pendingBulkAction && (
        <BulkConfirmationDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingBulkAction(null);
          }}
          action={pendingBulkAction.action}
          agents={pendingBulkAction.agents}
          onConfirm={handleConfirmBulkAction}
          isPending={bulkLifecycle.isPending}
        />
      )}

      {bulkResults && (
        <BulkResultsDialog
          open
          onClose={() => setBulkResults(null)}
          agentNames={bulkResults.agentNames}
          results={bulkResults.response.results}
          onRetryFailed={handleRetryFailed}
          isRetrying={bulkLifecycle.isPending}
        />
      )}
    </div>
  );
}
