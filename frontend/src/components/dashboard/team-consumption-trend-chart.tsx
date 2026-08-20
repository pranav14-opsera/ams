"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TeamConsumptionTrendPoint } from "@/types/dashboard";

function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface TeamConsumptionTrendChartProps {
  points: TeamConsumptionTrendPoint[];
}

/** AC 3's trend chart, team-scoped (reflecting whatever filters are currently applied) — same shape as ConsumptionTrendChart (WO-074), minus the period toggle (owned by UsageFilterPanel here, not this component, since period is one filter among several for this dashboard). */
export function TeamConsumptionTrendChart({ points }: TeamConsumptionTrendChartProps) {
  const chartData = points.map((point) => ({ ...point, label: formatDateLabel(point.date) }));

  if (points.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No consumption data available for this filter combination yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium">Team Consumption Trend</h3>
      <div className="h-64 w-full" role="img" aria-label="Team credit consumption over the selected date range and filters">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Line type="monotone" dataKey="credits" name="Credits consumed" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <details>
        <summary className="text-muted-foreground cursor-pointer text-sm">View as table</summary>
        <table className="mt-2 w-full text-sm">
          <caption className="sr-only">Team credit consumption trend</caption>
          <thead>
            <tr className="text-left">
              <th scope="col" className="py-1 pr-4">
                Date
              </th>
              <th scope="col" className="py-1">
                Credits Consumed
              </th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((point) => (
              <tr key={point.date} className="border-border border-t">
                <td className="py-1 pr-4">{point.label}</td>
                <td className="py-1">{point.credits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
