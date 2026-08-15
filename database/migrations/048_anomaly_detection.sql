-- WO-061: statistical anomaly detection — dynamic per-agent baselines
-- (EWMA for latency/error_rate, z-score for token consumption),
-- calibration lifecycle, and the same alert_events/alert_delivery_log
-- pipeline WO-059/060 already built.

CREATE TABLE drift_detection_configs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id       UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    -- AC: low=4 sigma, medium=3 sigma (default), high=2 sigma.
    sensitivity    TEXT NOT NULL DEFAULT 'medium' CHECK (sensitivity IN ('low', 'medium', 'high')),
    enabled        BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_agent_drift_config UNIQUE (tenant_id, agent_id)
);

CREATE INDEX idx_drift_detection_configs_tenant_agent ON drift_detection_configs (tenant_id, agent_id);
SELECT enable_tenant_isolation('drift_detection_configs');

CREATE TABLE anomaly_baselines (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id                 UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    metric_name              TEXT NOT NULL CHECK (metric_name IN ('latency_p99', 'error_rate', 'token_consumption')),
    -- EWMA state (latency_p99/error_rate) — null for token_consumption's z-score-only baseline.
    ewma_mean                DOUBLE PRECISION,
    ewma_variance            DOUBLE PRECISION,
    -- Static baseline mean/variance from the calibration window (z-score's own reference point; token_consumption's ONLY state, but also usable as EWMA's initial seed for the other two metrics).
    baseline_mean            DOUBLE PRECISION,
    baseline_variance        DOUBLE PRECISION,
    observation_count        INTEGER NOT NULL DEFAULT 0,
    calibration_started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL until the 7-day calibration window has elapsed AND baselines have been computed — this IS "calibration complete," checked directly rather than via a separate boolean that could drift out of sync.
    calibration_completed_at TIMESTAMPTZ,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_agent_metric_baseline UNIQUE (tenant_id, agent_id, metric_name)
);

CREATE INDEX idx_anomaly_baselines_tenant_agent ON anomaly_baselines (tenant_id, agent_id);
SELECT enable_tenant_isolation('anomaly_baselines');

-- Extend alert_events (migration 046) so anomaly-triggered events carry
-- the same statistical evidence WO-059's threshold-triggered events
-- don't need (expected_value/deviation_sigma/algorithm), while both
-- kinds flow through the exact same table/delivery pipeline (this WO's
-- own AC #5).
ALTER TABLE alert_events ADD COLUMN detection_method TEXT NOT NULL DEFAULT 'threshold' CHECK (detection_method IN ('threshold', 'anomaly'));
ALTER TABLE alert_events ADD COLUMN statistical_evidence JSONB;
