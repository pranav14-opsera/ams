"use client";

import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HealthHistoryPoint } from "@/types/dashboard";

function formatBucketLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export interface HealthHistoryChartProps {
  points: HealthHistoryPoint[];
}

/**
 * AC: line charts for latency percentiles + error rate, area chart for
 * token consumption, accessible color palette. Line STYLE (solid P50 /
 * dashed P99 / dotted error rate) differentiates series independent of
 * color, for readers who can't rely on hue alone — plain color alone
 * would fail a colorblind reader with P50/P99 both blue-ish.
 */
export function HealthHistoryChart({ points }: HealthHistoryChartProps) {
  if (points.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No metric data available for this time range.
      </p>
    );
  }

  const chartData = points.map((point) => ({ ...point, label: formatBucketLabel(point.bucket) }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="mb-2 text-sm font-medium">Latency (P50 / P99) &amp; Error Rate</h3>
        <div className="h-64 w-full" role="img" aria-label="Latency and error rate over time">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="latency" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="errorRate" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line yAxisId="latency" type="monotone" dataKey="latencyP50Ms" name="P50 latency (ms)" stroke="#2563eb" strokeDasharray="0" dot={false} />
              <Line yAxisId="latency" type="monotone" dataKey="latencyP99Ms" name="P99 latency (ms)" stroke="#7c3aed" strokeDasharray="6 3" dot={false} />
              <Line yAxisId="errorRate" type="monotone" dataKey="errorRateAvg" name="Error rate" stroke="#b45309" strokeDasharray="1 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">Token Consumption</h3>
        <div className="h-48 w-full" role="img" aria-label="Token consumption over time">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area type="monotone" dataKey="tokenConsumptionTotal" name="Tokens" stroke="#0f766e" fill="#0f766e" fillOpacity={0.25} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
