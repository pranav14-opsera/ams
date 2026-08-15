"use client";

import { useState } from "react";
import { AgentHealthCard } from "@/components/dashboard/agent-health-card";
import { FleetHealthSummary } from "@/components/dashboard/fleet-health-summary";
import { HealthFilterBar } from "@/components/dashboard/health-filter-bar";
import { useFleetHealthQuery } from "@/hooks/useFleetHealthQuery";
import { useHealthWebSocket } from "@/hooks/useHealthWebSocket";
import { applyHealthFilters, sortBySeverity } from "@/lib/agent-health";
import type { AgentHealthFilters, FleetHealthResult } from "@/types/dashboard";

/**
 * AC: real-time agent health overview. The live WebSocket feed (once
 * connected) is the source of truth for what's displayed — the initial
 * REST fetch (useFleetHealthQuery) exists only to paint something before
 * the socket has delivered its first push, and as the fallback if the
 * socket never connects at all.
 */
export default function AgentHealthDashboardPage() {
  const [filters, setFilters] = useState<AgentHealthFilters>({});
  const restQuery = useFleetHealthQuery(filters);
  const { latest: liveSnapshot, connectionState, isStale } = useHealthWebSocket();

  const source: FleetHealthResult | undefined = liveSnapshot ?? restQuery.data;

  if (restQuery.isLoading && !source) {
    return <p role="status">Loading agent health…</p>;
  }

  if (restQuery.isError && !source) {
    return <p role="alert">Unable to load agent health right now. Please try again shortly.</p>;
  }

  if (!source) {
    return <p role="status">No agent health data available yet.</p>;
  }

  const filteredAgents = liveSnapshot ? applyHealthFilters(liveSnapshot.agents, filters) : source.agents;
  const sortedAgents = sortBySeverity(filteredAgents);

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

      <div className="flex flex-col gap-3" role="list" aria-label="Agent health list">
        {sortedAgents.length === 0 ? (
          <p className="text-muted-foreground text-sm">No agents match the current filters.</p>
        ) : (
          sortedAgents.map((agent) => (
            <div key={agent.id} role="listitem">
              <AgentHealthCard agent={agent} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
