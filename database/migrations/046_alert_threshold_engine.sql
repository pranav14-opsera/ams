-- WO-059: configurable per-agent/per-metric alert thresholds + the
-- immutable alert events they produce when breached.

CREATE TABLE alert_threshold_configs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id           UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    metric_name        TEXT NOT NULL CHECK (metric_name IN ('error_rate', 'latency_p99', 'token_consumption_rate', 'resource_utilization')),
    warning_threshold  NUMERIC NOT NULL CHECK (warning_threshold >= 0),
    critical_threshold NUMERIC NOT NULL CHECK (critical_threshold >= 0),
    cooldown_seconds   INTEGER NOT NULL DEFAULT 300 CHECK (cooldown_seconds >= 0),
    created_by         UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- AC: "warning < critical" — enforced at the schema level, not just in application code.
    CONSTRAINT warning_below_critical CHECK (warning_threshold < critical_threshold),
    CONSTRAINT unique_agent_metric_threshold UNIQUE (tenant_id, agent_id, metric_name)
);

CREATE INDEX idx_alert_threshold_configs_tenant_agent ON alert_threshold_configs (tenant_id, agent_id);

SELECT enable_tenant_isolation('alert_threshold_configs');

-- Immutable — no UPDATE/DELETE path is ever exposed by AlertEventRepository (INSERT + SELECT only).
CREATE TABLE alert_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id          UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    metric_name       TEXT NOT NULL,
    threshold_value   NUMERIC NOT NULL,
    actual_value      NUMERIC NOT NULL,
    severity          TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    breach_timestamp  TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cooldown lookup: "most recent alert for this agent+metric" — DESC on breach_timestamp so LIMIT 1 hits the index directly.
CREATE INDEX idx_alert_events_tenant_agent_metric_breach ON alert_events (tenant_id, agent_id, metric_name, breach_timestamp DESC);

SELECT enable_tenant_isolation('alert_events');

-- ---------------------------------------------------------------------
-- RBAC: one new permission for threshold CRUD (AC: "Admin only for
-- create/update/delete"). Read access reuses agent_management:agent:read
-- (same "closest existing read-level grant" precedent as WO-056's own
-- health-dashboard endpoint), so only ONE new permission is added here,
-- not a separate read+write pair.
-- ---------------------------------------------------------------------
ALTER TABLE permissions DROP CONSTRAINT permissions_feature_area_check;
ALTER TABLE permissions ADD CONSTRAINT permissions_feature_area_check
    CHECK (feature_area IN (
        'agent_management', 'credit_management', 'audit_access', 'governance',
        'user_management', 'tenant_configuration', 'data_retention', 'reporting', 'alerting'
    ));

INSERT INTO permissions (name, display_name, description, feature_area, resource_type, action) VALUES
    ('alerting:threshold:manage', 'Manage Alert Thresholds', 'Create, update, and delete per-agent alert threshold configurations', 'alerting', 'threshold', 'manage');

INSERT INTO role_permissions (role_name, permission_name) VALUES
    ('platform_admin', 'alerting:threshold:manage');
