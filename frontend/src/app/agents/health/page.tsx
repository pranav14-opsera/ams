"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FleetHealthSummary } from "@/components/dashboard/fleet-health-summary";
import { HealthFilterBar } from "@/components/dashboard/health-filter-bar";
import { VirtualizedAgentGrid } from "@/components/dashboard/virtualized-agent-grid";
import { useFleetHealthInfiniteQuery } from "@/hooks/useFleetHealthInfiniteQuery";
import { useHealthMetricsWorker } from "@/hooks/useHealthMetricsWorker";
import { useHealthWebSocket } from "@/hooks/useHealthWebSocket";
import { applyHealthFilters } from "@/lib/agent-health";
import type { AgentHealthFilters, AgentHealthViewModel, FleetHealthResult } from "@/types/dashboard";

/**
 * AC: real-time agent health overview, scaled to 500+ agents (WO-058).
 * The live WebSocket feed (once connected) is the source of truth for
 * what's displayed — progressive REST pagination (useFleetHealthInfiniteQuery)
 * exists to paint something before the socket delivers its first push,
 * and as the fallback if the socket never connects. Sorting hundreds of
 * agents by severity is offloaded to a Web Worker (useHealthMetricsWorker)
 * rather than run synchronously on every render/update.
 */
export default function AgentHealthDashboardPage() {
  const router = useRouter();
  const [filters, setFilters] = useState<AgentHealthFilters>({});
  const worker = useHealthMetricsWorker();

  const infiniteQuery = useFleetHealthInfiniteQuery(filters);
  const { latest: liveSnapshot, connectionState, isStale } = useHealthWebSocket();

  const restAgents = useMemo(() => infiniteQuery.data?.pages.flatMap((page) => page.agents) ?? [], [infiniteQuery.data]);
  const restSource: FleetHealthResult | undefined = infiniteQuery.data?.pages[0];

  const source: FleetHealthResult | undefined = liveSnapshot ?? restSource;
  const displayedAgents = liveSnapshot ? applyHealthFilters(liveSnapshot.agents, filters) : restAgents;

  const [sortedAgents, setSortedAgents] = useState<AgentHealthViewModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    void worker.sortBySeverity(displayedAgents).then((sorted) => {
      if (!cancelled) setSortedAgents(sorted);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `worker` is a fresh object every render (its methods close over refs, not props/state) — depending on it would re-run this effect every render regardless of whether the agent list actually changed.
  }, [displayedAgents]);

  if (infiniteQuery.isLoading && !source) {
    return <p role="status">Loading agent health…</p>;
  }

  if (infiniteQuery.isError && !source) {
    return <p role="alert">Unable to load agent health right now. Please try again shortly.</p>;
  }

  if (!source) {
    return <p role="status">No agent health data available yet.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">Agent Health Overview</h2>
        <p className="text-muted-foreground text-sm" role="status">
          {connectionState === "connected" ? "Live" : connectionState === "reconnecting" ? "Reconnecting…" : "Offline"}
          {isStale ? " · data may be out of date" : ""}
          {source.servedFromCache ? " · showing last known snapshot" : ""}
        </p>
      </div>

      <FleetHealthSummary summary={source.summary} />

      <HealthFilterBar filters={filters} onChange={setFilters} />

      {sortedAgents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents match the current filters.</p>
      ) : (
        <VirtualizedAgentGrid
          agents={sortedAgents}
          onSelect={(agentId) => router.push(`/agents/health/detail?agentId=${agentId}`)}
          onLoadMore={() => infiniteQuery.fetchNextPage()}
          hasMore={!liveSnapshot && infiniteQuery.hasNextPage}
        />
      )}
    </div>
  );
}
