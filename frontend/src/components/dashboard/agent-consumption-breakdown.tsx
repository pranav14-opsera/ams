"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AgentConsumptionEntry } from "@/types/dashboard";

const TOP_N_DEFAULT = 10;
type SortDirection = "desc" | "asc";

export interface AgentConsumptionBreakdownProps {
  agents: AgentConsumptionEntry[];
}

/**
 * AC: bar chart broken down by agent, sortable by consumption volume,
 * top-10 visible by default, expandable to the full list, plus a
 * keyboard-navigable data-table alternative (technical_details AC:
 * "data tables must be keyboard navigable"). edge_cases: an agent
 * registered but never consuming credits still appears here with a
 * zero-height bar / zero row, never silently dropped — the service
 * layer already guarantees this (OrgUsageDashboardRepository.
 * getAgentBreakdown's LEFT JOIN FROM agents), this component just
 * doesn't filter it back out.
 */
export function AgentConsumptionBreakdown({ agents }: AgentConsumptionBreakdownProps) {
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => {
    const copy = [...agents];
    copy.sort((a, b) => (sortDirection === "desc" ? b.creditsConsumed - a.creditsConsumed : a.creditsConsumed - b.creditsConsumed));
    return copy;
  }, [agents, sortDirection]);

  const visible = expanded ? sorted : sorted.slice(0, TOP_N_DEFAULT);
  const hasMore = sorted.length > TOP_N_DEFAULT;

  if (agents.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No agents to display consumption for yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">Consumption by Agent</h3>
        <button
          type="button"
          className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
          onClick={() => setSortDirection((d) => (d === "desc" ? "asc" : "desc"))}
          aria-label={`Sort by consumption, currently ${sortDirection === "desc" ? "highest first" : "lowest first"}`}
        >
          Sort: {sortDirection === "desc" ? "Highest first" : "Lowest first"}
        </button>
      </div>

      <div className="h-72 w-full" role="img" aria-label={`Credit consumption by agent, showing ${visible.length} of ${sorted.length} agents`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visible} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="agentName" tick={{ fontSize: 11 }} width={140} />
            <Tooltip />
            <Bar dataKey="creditsConsumed" name="Credits consumed" fill="#0f766e" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {hasMore && (
        <button type="button" className="text-primary self-start text-sm underline" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show top 10 only" : `Show all ${sorted.length} agents`}
        </button>
      )}

      {/* Keyboard-navigable data table alternative to the chart above (technical_details AC). */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Credit consumption by agent</caption>
          <thead>
            <tr className="text-left">
              <th scope="col" className="py-1 pr-4">
                Agent
              </th>
              <th scope="col" className="py-1 pr-4">
                Framework
              </th>
              <th scope="col" className="py-1">
                Credits Consumed
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((agent) => (
              <tr key={agent.agentId} className="border-border border-t">
                <td className="py-1 pr-4">{agent.agentName}</td>
                <td className="py-1 pr-4">{agent.framework}</td>
                <td className="py-1">{agent.creditsConsumed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
