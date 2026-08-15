import type { AggregateGranularity } from "../adapters/metrics/metrics-aggregator.repository";

export const TIME_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

const RANGE_CONFIG: Record<TimeRange, { granularity: AggregateGranularity; durationMs: number }> = {
  "1h": { granularity: "5min", durationMs: 60 * 60 * 1000 },
  "6h": { granularity: "5min", durationMs: 6 * 60 * 60 * 1000 },
  // AC: "5min for short ranges, 1hr for medium, 1day for long" — 24h/7d
  // are the "medium" tier (1hr buckets: 24 / 168 points respectively,
  // vs. 288 / 2016 at 5min — a chart shouldn't render two thousand points).
  "24h": { granularity: "1hr", durationMs: 24 * 60 * 60 * 1000 },
  "7d": { granularity: "1hr", durationMs: 7 * 24 * 60 * 60 * 1000 },
  "30d": { granularity: "1day", durationMs: 30 * 24 * 60 * 60 * 1000 },
};

export function granularityForRange(range: TimeRange): AggregateGranularity {
  return RANGE_CONFIG[range].granularity;
}

export function sinceIsoForRange(range: TimeRange, now: Date = new Date()): string {
  return new Date(now.getTime() - RANGE_CONFIG[range].durationMs).toISOString();
}
