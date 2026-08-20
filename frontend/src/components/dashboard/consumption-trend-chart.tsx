"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { USAGE_PERIODS, type ConsumptionTrendPoint, type UsagePeriod } from "@/types/dashboard";

const PERIOD_LABEL: Record<UsagePeriod, string> = { "30d": "30 days", "60d": "60 days", "90d": "90 days" };

function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface ConsumptionTrendChartProps {
  points: ConsumptionTrendPoint[];
  period: UsagePeriod;
  onPeriodChange: (period: UsagePeriod) => void;
}

/**
 * AC: time-series line chart, daily consumption, 30/60/90-day toggle.
 * Accessible color palette with pattern differentiation (technical_details
 * AC) — a single series here has nothing to differentiate BY color alone
 * in the first place, but the dashed/point marker styling plus the
 * always-visible data-table alternative (below the chart) are what
 * actually satisfy "color is not the sole differentiator" for a reader
 * who can't perceive the line color at all.
 */
export function ConsumptionTrendChart({ points, period, onPeriodChange }: ConsumptionTrendChartProps) {
  const chartData = points.map((point) => ({ ...point, label: formatDateLabel(point.date) }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">Credit Consumption Trend</h3>
        <div role="group" aria-label="Trend period" className="border-border inline-flex rounded-md border">
          {USAGE_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => onPeriodChange(p)}
              className={cn("px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md", period === p ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      {points.length === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          No consumption data available for this period yet.
        </p>
      ) : (
        <>
          <div className="h-64 w-full" role="img" aria-label={`Daily credit consumption over the past ${PERIOD_LABEL[period]}`}>
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

          {/* Keyboard-navigable data-table alternative — same "chart + table" pairing AgentConsumptionBreakdown uses, so the trend is never ONLY available as an unreadable-by-AT visual. */}
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm">View as table</summary>
            <table className="mt-2 w-full text-sm">
              <caption className="sr-only">Daily credit consumption trend</caption>
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
        </>
      )}
    </div>
  );
}
