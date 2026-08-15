-- WO-042 seed script: raw agent_metrics rows covering all five metric
-- names (latency_ms, error_rate, throughput_rps, token_consumption,
-- tool_call_success), then refreshes all four aggregate granularities
-- (5s/15s/60s/5min) so the _scoped views have data to return immediately.
--
-- Deliberately does NOT create its own tenants/agents: `agents` rows now
-- require real BYOK-encrypted connection_config/hmac_secret columns
-- (migrations 031/034), which a raw seed script can't produce correctly
-- (only EncryptionService, wired through real KMS, can) — attempting to
-- fake those columns would seed agents that fail every real encrypted-
-- field read path. Instead, this seeds metrics for whichever agents
-- already exist in the target database (e.g. from running the backend's
-- own integration tests, or from creating agents via the API), and is a
-- safe no-op if none exist yet.
--
-- Run as postgres/superuser, local development and CI only.

DO $$
DECLARE
    agent_count INT;
BEGIN
    SELECT count(*) INTO agent_count FROM agents;
    IF agent_count = 0 THEN
        RAISE NOTICE 'agent_metrics_multi_granularity_seed: no agents exist yet in this database — nothing to seed. Create at least one agent first (e.g. via the Agents API or an integration test fixture), then re-run this script.';
    END IF;
END $$;

INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value, recorded_at)
SELECT
    a.tenant_id,
    a.id,
    metric.name,
    metric.value,
    now() - (series.n || ' seconds')::interval
FROM agents a
CROSS JOIN LATERAL (
    SELECT n FROM generate_series(0, 299) AS n
) series
CROSS JOIN LATERAL (
    VALUES
        ('latency_ms', 40 + (series.n % 250)::double precision + (CASE WHEN series.n % 47 = 0 THEN 700 ELSE 0 END)),
        ('error_rate', (CASE WHEN series.n % 20 = 0 THEN 1 ELSE 0 END)::double precision),
        ('throughput_rps', (5 + (series.n % 10))::double precision),
        ('token_consumption', (100 + (series.n % 400))::double precision),
        ('tool_call_success', (CASE WHEN series.n % 10 = 0 THEN 0 ELSE 1 END)::double precision)
) AS metric(name, value);

-- First refresh of each view must be plain (WITH NO DATA views reject
-- CONCURRENTLY until populated once) — matches migration 007/036's own
-- documented requirement.
REFRESH MATERIALIZED VIEW agent_metrics_5min_agg;
REFRESH MATERIALIZED VIEW agent_health_5s_agg;
REFRESH MATERIALIZED VIEW agent_credits_15s_agg;
REFRESH MATERIALIZED VIEW agent_analytics_60s_agg;
