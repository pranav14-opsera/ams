import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

export type AgentMetricName = "latency_ms" | "error_rate" | "throughput_rps" | "token_consumption" | "tool_call_success";

export type AggregateGranularity = "5s" | "15s" | "60s" | "5min";

const SCOPED_VIEW_BY_GRANULARITY: Record<AggregateGranularity, string> = {
  "5s": "agent_health_5s_agg_scoped",
  "15s": "agent_credits_15s_agg_scoped",
  "60s": "agent_analytics_60s_agg_scoped",
  "5min": "agent_metrics_5min_agg_scoped",
};

export interface AgentMetricsAggregateRow {
  bucket: Date;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  errorRateAvg: number | null;
  tokenConsumptionTotal: number | null;
  toolCallSuccessRateAvg: number | null;
}

@Injectable()
export class MetricsAggregatorRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async recordMetric(tenantId: string, agentId: string, metricName: AgentMetricName, value: number, client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value) VALUES ($1, $2, $3, $4)", [tenantId, agentId, metricName, value]);
  }

  /** Reads the pre-aggregated 5-minute-bucket P50/P99 latency + error rate (migration 007's materialized-view TimescaleDB substitute) for one agent within a time range. */
  async findAggregates(
    tenantId: string,
    agentId: string,
    sinceIso: string,
    client?: Pool | PoolClient,
  ): Promise<Array<{ bucket: Date; latencyP50Ms: number | null; latencyP99Ms: number | null; errorRateAvg: number | null }>> {
    const rows = await this.findAggregatesByGranularity("5min", tenantId, agentId, sinceIso, client);
    return rows.map((row) => ({ bucket: row.bucket, latencyP50Ms: row.latencyP50Ms, latencyP99Ms: row.latencyP99Ms, errorRateAvg: row.errorRateAvg }));
  }

  /** WO-042: reads any of the four multi-granularity aggregate views (health/credits/analytics/pre-existing 5min), all sharing the same _scoped tenant-filtering shape. */
  async findAggregatesByGranularity(
    granularity: AggregateGranularity,
    tenantId: string,
    agentId: string,
    sinceIso: string,
    client?: Pool | PoolClient,
  ): Promise<AgentMetricsAggregateRow[]> {
    const executor = client ?? this.pool;
    const view = SCOPED_VIEW_BY_GRANULARITY[granularity];
    const result = await executor.query(
      `SELECT bucket, latency_p50_ms, latency_p99_ms, error_rate_avg, token_consumption_total, tool_call_success_rate_avg
       FROM ${view}
       WHERE tenant_id = $1 AND agent_id = $2 AND bucket >= $3
       ORDER BY bucket ASC`,
      [tenantId, agentId, sinceIso],
    );
    return result.rows.map((row) => ({
      bucket: row.bucket,
      latencyP50Ms: row.latency_p50_ms,
      latencyP99Ms: row.latency_p99_ms,
      errorRateAvg: row.error_rate_avg,
      tokenConsumptionTotal: row.token_consumption_total ?? null,
      toolCallSuccessRateAvg: row.tool_call_success_rate_avg ?? null,
    }));
  }
}
