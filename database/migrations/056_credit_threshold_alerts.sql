-- WO-069: credit threshold alert notifications — one alert per
-- (team, threshold level, period), delivered via email/webhook/in-app.

CREATE TABLE credit_alerts (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    team_id                UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    threshold_level        INTEGER NOT NULL CHECK (threshold_level IN (75, 90)),
    consumption_percentage NUMERIC(6, 2) NOT NULL,
    effective_month        INTEGER NOT NULL CHECK (effective_month BETWEEN 1 AND 12),
    effective_year         INTEGER NOT NULL CHECK (effective_year >= 2020),
    generated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- AC: "at most once per team per effective period" per threshold level.
    CONSTRAINT unique_alert_per_team_threshold_period UNIQUE (tenant_id, team_id, threshold_level, effective_month, effective_year)
);

CREATE INDEX idx_credit_alerts_tenant_period ON credit_alerts (tenant_id, effective_month, effective_year);
SELECT enable_tenant_isolation('credit_alerts');
GRANT SELECT, INSERT ON credit_alerts TO ams_app;
