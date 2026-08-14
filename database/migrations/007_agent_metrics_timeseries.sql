-- Time-series storage for agent metrics (latency, error rate, throughput).
--
-- IMPORTANT — architecture deviation from the work order, called out
-- explicitly: AWS RDS for PostgreSQL does NOT support the TimescaleDB
-- extension (neither does Aurora PostgreSQL) — it's a well-documented AWS
-- platform limitation, not a configuration gap. TimescaleDB requires a
-- self-managed EC2/container PostgreSQL instance or Timescale Cloud. Since
-- this platform runs on RDS (see infrastructure/terraform/database/
-- postgresql), this migration implements the same practical requirements
-- — efficient time-range storage with automatic partition pruning, and a
-- fast pre-aggregated read path for dashboards — using native PostgreSQL
-- declarative RANGE partitioning (in place of TimescaleDB hypertable
-- chunks) and a materialized view refreshed on a schedule (in place of a
-- TimescaleDB continuous aggregate).
--
-- If true TimescaleDB features are later required (compression, native
-- continuous aggregates with real-time incremental refresh, hypertable-
-- specific query planner optimizations), that's a platform-level decision
-- to run agent_metrics on separate self-managed infrastructure — out of
-- scope for this migration.

CREATE TABLE agent_metrics (
    id           BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id     UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    metric_name  TEXT NOT NULL CHECK (metric_name IN ('latency_ms', 'error_rate', 'throughput_rps')),
    value        DOUBLE PRECISION NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE INDEX idx_agent_metrics_tenant_agent_time ON agent_metrics (tenant_id, agent_id, recorded_at);

SELECT enable_tenant_isolation('agent_metrics');

-- 1-hour chunks (matching the hypertable chunk interval the work order
-- specified), created on demand by this function — called at migration
-- time for the current window and intended to run hourly thereafter
-- (e.g. via a scheduled Lambda/cron, not implemented here).
CREATE OR REPLACE FUNCTION create_agent_metrics_partitions(start_time TIMESTAMPTZ, hours_ahead INT DEFAULT 24)
RETURNS void AS $$
DECLARE
    partition_start TIMESTAMPTZ;
    partition_end TIMESTAMPTZ;
    partition_name TEXT;
    i INT;
BEGIN
    FOR i IN 0..hours_ahead - 1 LOOP
        partition_start := date_trunc('hour', start_time) + (i || ' hours')::interval;
        partition_end := partition_start + interval '1 hour';
        partition_name := 'agent_metrics_' || to_char(partition_start, 'YYYY_MM_DD_HH24');

        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF agent_metrics FOR VALUES FROM (%L) TO (%L)',
                partition_name, partition_start, partition_end
            );
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT create_agent_metrics_partitions(now(), 24);

-- Continuous-aggregate substitute: P50/P99 latency and error rate,
-- pre-computed per agent per 5-minute bucket. Refresh on a schedule (a
-- pg_cron job or external scheduler calling
-- REFRESH MATERIALIZED VIEW CONCURRENTLY) rather than TimescaleDB's
-- automatic incremental refresh.
CREATE MATERIALIZED VIEW agent_metrics_5min_agg AS
SELECT
    tenant_id,
    agent_id,
    date_trunc('hour', recorded_at) + (floor(date_part('minute', recorded_at) / 5) * interval '5 minutes') AS bucket,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FILTER (WHERE metric_name = 'latency_ms') AS latency_p50_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY value) FILTER (WHERE metric_name = 'latency_ms') AS latency_p99_ms,
    avg(value) FILTER (WHERE metric_name = 'error_rate') AS error_rate_avg,
    avg(value) FILTER (WHERE metric_name = 'throughput_rps') AS throughput_avg_rps
FROM agent_metrics
GROUP BY tenant_id, agent_id, bucket
WITH NO DATA;

-- A unique index is required for REFRESH MATERIALIZED VIEW CONCURRENTLY,
-- which is what lets refreshes not block concurrent dashboard reads.
CREATE UNIQUE INDEX idx_agent_metrics_5min_agg_pk ON agent_metrics_5min_agg (tenant_id, agent_id, bucket);

-- WITH NO DATA above means the view starts unpopulated. The very first
-- refresh MUST be a plain `REFRESH MATERIALIZED VIEW` (no CONCURRENTLY —
-- Postgres rejects CONCURRENTLY against an unpopulated view). Every
-- refresh after that first one can and should use CONCURRENTLY.

-- PostgreSQL RLS policies apply only to tables, never to materialized
-- views — so agent_metrics_5min_agg itself carries NO tenant isolation.
-- Nothing may query it directly; every read goes through this view
-- instead, which re-applies the same tenant_id = current_setting(...)
-- filter the underlying table's RLS policy uses.
CREATE VIEW agent_metrics_5min_agg_scoped AS
SELECT * FROM agent_metrics_5min_agg
WHERE tenant_id = current_setting('app.current_tenant', true)::uuid;

REVOKE ALL ON agent_metrics_5min_agg FROM PUBLIC;
