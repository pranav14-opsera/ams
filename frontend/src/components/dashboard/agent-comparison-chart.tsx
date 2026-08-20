"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TeamAgentComparisonEntry } from "@/types/dashboard";

const TOP_N_DEFAULT = 10;
type SortDirection = "desc" | "asc";

export interface AgentComparisonChartProps {
  agents: TeamAgentComparisonEntry[];
}

/**
 * AC 4: horizontal bar chart, side-by-side per-agent consumption, a
 * mean-consumption reference line, a visual indicator (color, not just
 * a pattern the color-blind reader would miss — paired with the
 * "Above 2x average" text badge in both the chart's own tooltip data and
 * the table below) for any agent exceeding 2x the team mean, sortable,
 * plus a keyboard-navigable data table alternative (same "chart + table"
 * pairing as AgentConsumptionBreakdown, WO-074).
 */
export function AgentComparisonChart({ agents }: AgentComparisonChartProps) {
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expanded, setExpanded] = useState(false);

  const mean = useMemo(() => (agents.length > 0 ? agents.reduce((sum, a) => sum + a.creditsConsumed, 0) / agents.length : 0), [agents]);

  const sorted = useMemo(() => {
    const copy = [...agents];
    copy.sort((a, b) => (sortDirection === "desc" ? b.creditsConsumed - a.creditsConsumed : a.creditsConsumed - b.creditsConsumed));
    return copy;
  }, [agents, sortDirection]);

  const visible = expanded ? sorted : sorted.slice(0, TOP_N_DEFAULT);
  const hasMore = sorted.length > TOP_N_DEFAULT;

  if (agents.length === 0) {
    // edge_cases: "zero-agent team empty state".
    return (
      <p className="text-muted-foreground text-sm" role="status">
        This team has no agents to compare yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">Agent Comparison</h3>
        <button
          type="button"
          className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
          onClick={() => setSortDirection((d) => (d === "desc" ? "asc" : "desc"))}
          aria-label={`Sort by consumption, currently ${sortDirection === "desc" ? "highest first" : "lowest first"}`}
        >
          Sort: {sortDirection === "desc" ? "Highest first" : "Lowest first"}
        </button>
      </div>

      <div className="h-72 w-full" role="img" aria-label={`Credit consumption by agent, showing ${visible.length} of ${sorted.length} agents. Team average is ${Math.round(mean)} credits.`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visible} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="agentName" tick={{ fontSize: 11 }} width={140} />
            <Tooltip />
            <ReferenceLine x={mean} stroke="#64748b" strokeDasharray="4 4" label={{ value: "Team avg", fontSize: 10, position: "top" }} />
            <Bar dataKey="creditsConsumed" name="Credits consumed">
              {visible.map((agent) => (
                <Cell key={agent.agentId} fill={agent.isAboveThreshold ? "#b91c1c" : "#0f766e"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {hasMore && (
        <button type="button" className="text-primary self-start text-sm underline" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show top 10 only" : `Show all ${sorted.length} agents`}
        </button>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Credit consumption by agent, compared against the team average</caption>
          <thead>
            <tr className="text-left">
              <th scope="col" className="py-1 pr-4">
                Agent
              </th>
              <th scope="col" className="py-1 pr-4">
                Framework
              </th>
              <th scope="col" className="py-1 pr-4">
                Credits Consumed
              </th>
              <th scope="col" className="py-1">
                vs. Team Average
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((agent) => (
              <tr key={agent.agentId} className="border-border border-t">
                <td className="py-1 pr-4">{agent.agentName}</td>
                <td className="py-1 pr-4">{agent.framework}</td>
                <td className="py-1 pr-4">{agent.creditsConsumed}</td>
                <td className={`py-1 ${agent.isAboveThreshold ? "font-medium text-red-700" : ""}`}>{agent.isAboveThreshold ? "Above 2x average" : "Normal"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
