-- WO-057: two more aggregate granularities — 1hr and 1day — alongside
-- the pre-existing 5s/15s/60s/5min ones (migration 036), so the health
-- drill-down view's 24h/7d/30d time ranges can query a bucket size
-- proportionate to the range instead of returning thousands of 5-minute
-- rows for a 30-day chart. Same TimescaleDB-unavailable substitute
-- established in migration 007/036 (native partitioning + materialized
-- view + WITH NO DATA / unique-index / _scoped-wrapper-view pattern) —
-- see TIMESCALEDB_SCHEMA.md for the full reconciliation.

CREATE MATERIALIZED VIEW agent_metrics_1hr_agg AS
SELECT
    tenant_id,
    agent_id,
    date_trunc('hour', recorded_at) AS bucket,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FILTER (WHERE metric_name = 'latency_ms') AS latency_p50_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY value) FILTER (WHERE metric_name = 'latency_ms') AS latency_p99_ms,
    avg(value) FILTER (WHERE metric_name = 'error_rate') AS error_rate_avg,
    sum(value) FILTER (WHERE metric_name = 'token_consumption') AS token_consumption_total,
    avg(value) FILTER (WHERE metric_name = 'tool_call_success') AS tool_call_success_rate_avg
FROM agent_metrics
GROUP BY tenant_id, agent_id, bucket
WITH NO DATA;

CREATE UNIQUE INDEX idx_agent_metrics_1hr_agg_pk ON agent_metrics_1hr_agg (tenant_id, agent_id, bucket);
CREATE VIEW agent_metrics_1hr_agg_scoped AS
SELECT * FROM agent_metrics_1hr_agg WHERE tenant_id = current_setting('app.current_tenant', true)::uuid;
REVOKE ALL ON agent_metrics_1hr_agg FROM PUBLIC;

CREATE MATERIALIZED VIEW agent_metrics_1day_agg AS
SELECT
    tenant_id,
    agent_id,
    date_trunc('day', recorded_at) AS bucket,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FILTER (WHERE metric_name = 'latency_ms') AS latency_p50_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY value) FILTER (WHERE metric_name = 'latency_ms') AS latency_p99_ms,
    avg(value) FILTER (WHERE metric_name = 'error_rate') AS error_rate_avg,
    sum(value) FILTER (WHERE metric_name = 'token_consumption') AS token_consumption_total,
    avg(value) FILTER (WHERE metric_name = 'tool_call_success') AS tool_call_success_rate_avg
FROM agent_metrics
GROUP BY tenant_id, agent_id, bucket
WITH NO DATA;

CREATE UNIQUE INDEX idx_agent_metrics_1day_agg_pk ON agent_metrics_1day_agg (tenant_id, agent_id, bucket);
CREATE VIEW agent_metrics_1day_agg_scoped AS
SELECT * FROM agent_metrics_1day_agg WHERE tenant_id = current_setting('app.current_tenant', true)::uuid;
REVOKE ALL ON agent_metrics_1day_agg FROM PUBLIC;

-- Retention: raw agent_metrics is already dropped after 90 days
-- (migration 036's drop_expired_agent_metrics_partitions) — both new
-- aggregates recompute from that same raw table on refresh, so once a
-- partition is dropped, the next refresh naturally excludes it from
-- these views too. No separate retention step needed, same reasoning
-- migration 036 already documents for its own three added granularities.
