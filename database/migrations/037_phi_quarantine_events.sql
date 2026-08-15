-- WO-043: quarantine store for telemetry events where PhiSecondaryValidator
-- (defense-in-depth re-scan run after primary PHI scrubbing) still detects
-- PHI-shaped content in the already-scrubbed output. Modeled directly on
-- telemetry_dead_letter_events (migration 034) — same shape, same RLS +
-- tenant-context-guard wiring — since both are "this telemetry event
-- cannot proceed to Kafka, hold it for manual review" stores; the only
-- difference is WHY (a publish failure vs. a compliance gate).
--
-- The payload column intentionally stores the SAME event that failed
-- validation (pre-Kafka), not a further-redacted copy: a human reviewer
-- needs to see what the secondary validator actually flagged in order to
-- fix the underlying pattern gap, and this table is never itself
-- published anywhere downstream.
CREATE TABLE phi_quarantine_events (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id           UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    event_id           UUID NOT NULL,
    payload            JSONB NOT NULL,
    quarantine_reason  TEXT NOT NULL,
    reviewed           BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_phi_quarantine_tenant_agent ON phi_quarantine_events (tenant_id, agent_id, created_at);

SELECT enable_tenant_isolation('phi_quarantine_events');
SELECT attach_tenant_context_guard('phi_quarantine_events');

GRANT SELECT, INSERT, UPDATE, DELETE ON phi_quarantine_events TO ams_app;
