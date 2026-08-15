-- WO-063: agent quality score computation engine — a weighted composite
-- of tool-call success rate, reasoning accuracy, and output consistency,
-- computed every 5 minutes and stored for trend analysis. Same native-
-- partitioning-not-required reasoning as migration 048/049: at a 5-minute
-- cadence per agent (288 rows/agent/day), this is a much lower write
-- volume than raw agent_metrics (migration 007's own reason for
-- partitioning) — a plain RLS-protected table with a time-ordered index
-- is proportionate here, not partitioning for its own sake.

CREATE TABLE quality_score_configs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- AC: defaults 40/35/25 — CHECKed to sum to 100 so a caller can't silently misconfigure weights that don't add up to a real percentage split.
    tool_call_weight  INTEGER NOT NULL DEFAULT 40 CHECK (tool_call_weight >= 0 AND tool_call_weight <= 100),
    reasoning_weight  INTEGER NOT NULL DEFAULT 35 CHECK (reasoning_weight >= 0 AND reasoning_weight <= 100),
    consistency_weight INTEGER NOT NULL DEFAULT 25 CHECK (consistency_weight >= 0 AND consistency_weight <= 100),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_config_per_tenant UNIQUE (tenant_id),
    CONSTRAINT weights_sum_to_100 CHECK (tool_call_weight + reasoning_weight + consistency_weight = 100)
);

SELECT enable_tenant_isolation('quality_score_configs');

CREATE TABLE quality_score_history (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id           UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    tool_call_score    DOUBLE PRECISION,
    reasoning_score    DOUBLE PRECISION,
    consistency_score  DOUBLE PRECISION,
    composite_score    DOUBLE PRECISION,
    -- Number of components that had enough real data to contribute a score this tick (0-3) — lets a caller distinguish "score computed from all 3 signals" from "computed from a partial, reweighted subset".
    sample_count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_quality_score_history_tenant_agent_time ON quality_score_history (tenant_id, agent_id, computed_at DESC);
SELECT enable_tenant_isolation('quality_score_history');

CREATE TABLE quality_score_baselines (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id                UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    baseline_score          DOUBLE PRECISION,
    calibration_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL until the 7-day calibration window has elapsed AND a baseline has actually been computed — this IS "baseline established," same pattern as migration 048's calibration_completed_at.
    established_at          TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_baseline_per_agent UNIQUE (tenant_id, agent_id)
);

CREATE INDEX idx_quality_score_baselines_tenant_agent ON quality_score_baselines (tenant_id, agent_id);
SELECT enable_tenant_isolation('quality_score_baselines');
