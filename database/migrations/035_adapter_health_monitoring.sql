-- WO-039: adapter version compatibility matrix + automated health
-- monitoring. Platform-wide configuration (one row per framework_type,
-- not per-tenant) — same "global, not tenant-scoped" reasoning as
-- migration 024's roles/permissions tables, so no RLS here.
CREATE TABLE adapter_configurations (
    adapter_type                 TEXT PRIMARY KEY
                                  CHECK (adapter_type IN ('langchain', 'crewai', 'autogen', 'generic_rest')),
    adapter_version               TEXT NOT NULL,
    -- A semver range string (node-semver syntax, e.g. ">=0.2.0 <0.4.0") —
    -- stored as text since ranges aren't a native Postgres type; matching
    -- happens application-side via the `semver` package.
    supported_framework_versions  TEXT NOT NULL,
    health_status                 TEXT NOT NULL DEFAULT 'healthy'
                                  CHECK (health_status IN ('healthy', 'degraded', 'unhealthy')),
    consecutive_failures           INT NOT NULL DEFAULT 0,
    last_health_check_at           TIMESTAMPTZ,
    health_check_interval_seconds  INT NOT NULL DEFAULT 60,
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE adapter_health_checks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    adapter_type     TEXT NOT NULL REFERENCES adapter_configurations (adapter_type) ON DELETE CASCADE,
    check_timestamp  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status           TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy')),
    response_time_ms INT,
    error_details    TEXT
);

CREATE INDEX idx_adapter_health_checks_type_time ON adapter_health_checks (adapter_type, check_timestamp DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON adapter_configurations TO ams_app;
GRANT SELECT, INSERT, DELETE ON adapter_health_checks TO ams_app;

-- Seed the 4 documented framework adapters (WO-035 through WO-038) with
-- their actual adapter versions (LANGCHAIN_ADAPTER_VERSION etc., all
-- "1.0.0" today) and a conservative initial supported-version range.
INSERT INTO adapter_configurations (adapter_type, adapter_version, supported_framework_versions) VALUES
    ('langchain',    '1.0.0', '>=0.2.0 <0.4.0'),
    ('crewai',       '1.0.0', '>=0.30.0 <0.60.0'),
    ('autogen',      '1.0.0', '>=0.2.0 <0.5.0'),
    ('generic_rest', '1.0.0', '*');
