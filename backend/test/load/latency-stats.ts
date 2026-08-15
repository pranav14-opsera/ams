/**
 * WO-044: per-segment latency statistics. Uses exact sort-based
 * percentiles rather than a streaming approximation (t-digest) — at this
 * load test's realistic sample sizes (tens of thousands of events at
 * most, held in memory for the duration of one run), exact percentiles
 * are both simpler and more accurate than an approximation algorithm
 * whose only advantage is bounded memory for unbounded streams.
 */
export interface SegmentStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function computeSegmentStats(samplesMs: number[]): SegmentStats {
  if (samplesMs.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
  };
}

export class LatencyCollector {
  private readonly samplesByStage = new Map<string, number[]>();

  record(stage: string, elapsedMs: number): void {
    const existing = this.samplesByStage.get(stage);
    if (existing) {
      existing.push(elapsedMs);
    } else {
      this.samplesByStage.set(stage, [elapsedMs]);
    }
  }

  stats(): Record<string, SegmentStats> {
    const result: Record<string, SegmentStats> = {};
    for (const [stage, samples] of this.samplesByStage.entries()) {
      result[stage] = computeSegmentStats(samples);
    }
    return result;
  }

  stages(): string[] {
    return [...this.samplesByStage.keys()];
  }
}
