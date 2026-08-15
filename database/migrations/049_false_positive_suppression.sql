-- WO-062: false-positive feedback loop on top of WO-059/060/061's alert
-- pipeline — one-click confirm/dismiss feedback, per-pattern snoozes, and
-- an hourly auto-tune pass that widens the WARNING threshold (never the
-- critical one — see AlertAutoTuneStateRepository/ThresholdEvaluatorService
-- for why) for agent+metric patterns with sustained false-positive
-- feedback and no confirmations.

CREATE TABLE false_positive_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    alert_event_id  UUID NOT NULL REFERENCES alert_events (id) ON DELETE CASCADE,
    -- Denormalized off alert_events.metric_name (a plain TEXT column there too, per migration 048's own reasoning — no CHECK vocabulary to inherit).
    metric_name     TEXT NOT NULL,
    feedback_type   TEXT NOT NULL CHECK (feedback_type IN ('confirmed', 'false_positive')),
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One-click feedback is idempotent per alert: a second submission on the same alert corrects the first rather than accumulating duplicates.
    CONSTRAINT unique_feedback_per_alert_event UNIQUE (alert_event_id)
);

CREATE INDEX idx_false_positive_feedback_pattern ON false_positive_feedback (tenant_id, agent_id, metric_name, created_at);
SELECT enable_tenant_isolation('false_positive_feedback');

CREATE TABLE alert_snooze_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    metric_name     TEXT NOT NULL,
    snoozed_until   TIMESTAMPTZ NOT NULL,
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One active snooze per pattern — a new snooze on the same pattern replaces (extends/shortens) the existing one rather than stacking.
    CONSTRAINT unique_snooze_per_pattern UNIQUE (tenant_id, agent_id, metric_name)
);

CREATE INDEX idx_alert_snooze_configs_lookup ON alert_snooze_configs (tenant_id, agent_id, metric_name, snoozed_until);
SELECT enable_tenant_isolation('alert_snooze_configs');

-- Auto-tune state, kept SEPARATE from alert_threshold_configs' own
-- warning/critical columns: the multiplier scales the ORIGINAL,
-- user-configured warningThreshold at evaluation time rather than
-- mutating it in place, so "capped at 2x original" (this WO's AC) has a
-- stable reference point to cap against, and a threshold edit by an
-- operator is never silently overwritten by auto-tuning (or vice versa).
CREATE TABLE alert_auto_tune_state (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id              UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    metric_name           TEXT NOT NULL,
    warning_multiplier    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    last_tuned_at         TIMESTAMPTZ,
    -- False-positive feedback older than this was already accounted for by a prior tuning pass — the auto-tune scheduler only re-tunes off feedback newer than its own last run, so sustained-but-already-acted-on feedback doesn't cause runaway hourly increases.
    feedback_cursor       TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_auto_tune_per_pattern UNIQUE (tenant_id, agent_id, metric_name)
);

CREATE INDEX idx_alert_auto_tune_state_pattern ON alert_auto_tune_state (tenant_id, agent_id, metric_name);
SELECT enable_tenant_isolation('alert_auto_tune_state');
