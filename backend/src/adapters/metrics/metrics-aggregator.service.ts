import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";
import { MetricsAggregatorRepository } from "./metrics-aggregator.repository";

/**
 * WO-041's "Metrics Aggregator": computes rolling P50/P99 latency and
 * error rate per agent. The pre-existing agent_metrics table + its
 * agent_metrics_5min_agg materialized view (migration 007, this
 * codebase's documented TimescaleDB-on-RDS substitute using native
 * partitioning + percentile_cont) already implement the actual
 * aggregation math — this service's job is just to feed it real data
 * points, one row per canonical event's latency_ms/error_rate.
 *
 * Architecturally inline (called directly from TelemetryPipelineService
 * after a canonical event is produced) rather than a standalone Kafka
 * consumer group: this sandbox has no reachable Kafka broker (the same
 * documented gap as WO-034/040 — see TELEMETRY_PIPELINE.md), so a
 * consumer that can never actually consume anything here would be
 * untested theater. Calling this synchronously in the same request path
 * is functionally equivalent for this platform's current single-instance
 * deployment and is honestly testable against real Postgres today; see
 * STREAM_PROCESSING.md for the full reconciliation.
 */
@Injectable()
export class MetricsAggregatorService {
  private readonly logger = new Logger(MetricsAggregatorService.name);

  constructor(private readonly repository: MetricsAggregatorRepository) {}

  async recordCanonicalEvent(client: Pool | PoolClient | undefined, event: CanonicalTelemetryEvent): Promise<void> {
    // Best-effort: a metrics-recording failure must never break telemetry
    // ingestion itself (the canonical event has already been accepted and
    // is on its way to Kafka/the dead-letter table by this point) — same
    // "never let an observability side-channel take down the primary
    // path" principle as PhiMaskingLogger replacing Nest's own logger.
    try {
      if (event.latency_ms !== null) {
        await this.repository.recordMetric(event.tenant_id, event.agent_id, "latency_ms", event.latency_ms, client);
      }
      if (event.error_rate !== null) {
        await this.repository.recordMetric(event.tenant_id, event.agent_id, "error_rate", event.error_rate, client);
      }
      if (event.token_consumption !== null) {
        await this.repository.recordMetric(event.tenant_id, event.agent_id, "token_consumption", event.token_consumption, client);
      }
      if (event.tool_call_success !== null) {
        // Stored as 1/0 so the aggregate views can compute an average
        // ("tool-call success rate") the same way error_rate_avg is
        // computed — a boolean column can't feed avg()/percentile_cont().
        await this.repository.recordMetric(event.tenant_id, event.agent_id, "tool_call_success", event.tool_call_success ? 1 : 0, client);
      }
    } catch (err) {
      this.logger.warn(`failed to record metrics for event ${event.event_id}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
