-- WO-064: behavioral drift detection — compares the last 24h of an
-- agent's quality scores (WO-063) against its calibration-window
-- baseline distribution using a two-sample KS test, requiring 3
-- consecutive drifting hourly windows before alerting.

CREATE TABLE drift_events (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id               UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    detected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    ks_statistic           DOUBLE PRECISION NOT NULL,
    p_value                DOUBLE PRECISION NOT NULL,
    baseline_mean          DOUBLE PRECISION NOT NULL,
    current_mean           DOUBLE PRECISION NOT NULL,
    degradation_magnitude  DOUBLE PRECISION NOT NULL,
    -- Which of the 3 quality-score components moved the most between baseline and current — {"toolCall": delta, "reasoning": delta, "consistency": delta}.
    affected_components    JSONB NOT NULL DEFAULT '{}'::jsonb,
    consecutive_window_count INTEGER NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_drift_events_tenant_agent_time ON drift_events (tenant_id, agent_id, detected_at DESC);
SELECT enable_tenant_isolation('drift_events');

-- Durable copy of the consecutive-window counter (AC: "PostgreSQL
-- fallback for state recovery" alongside the hot Redis cache) — same
-- "Redis for the hot per-tick path, Postgres as the restart-survives
-- source of truth" pattern as WO-061's EwmaStateCacheService /
-- AnomalyBaselineRepository.updateEwmaState.
CREATE TABLE drift_detection_state (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id                 UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    consecutive_drift_count  INTEGER NOT NULL DEFAULT 0,
    last_evaluated_at        TIMESTAMPTZ,
    last_ks_statistic        DOUBLE PRECISION,
    last_p_value             DOUBLE PRECISION,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_drift_state_per_agent UNIQUE (tenant_id, agent_id)
);

SELECT enable_tenant_isolation('drift_detection_state');

-- WO-061's own detection-method vocabulary gains a 3rd value.
ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_detection_method_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_detection_method_check CHECK (detection_method IN ('threshold', 'anomaly', 'drift'));
