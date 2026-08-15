import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

export type AgentMetricName = "latency_ms" | "error_rate" | "throughput_rps";

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
    const executor = client ?? this.pool;
    const result = await executor.query(
      `SELECT bucket, latency_p50_ms, latency_p99_ms, error_rate_avg
       FROM agent_metrics_5min_agg_scoped
       WHERE tenant_id = $1 AND agent_id = $2 AND bucket >= $3
       ORDER BY bucket ASC`,
      [tenantId, agentId, sinceIso],
    );
    return result.rows.map((row) => ({ bucket: row.bucket, latencyP50Ms: row.latency_p50_ms, latencyP99Ms: row.latency_p99_ms, errorRateAvg: row.error_rate_avg }));
  }
}
