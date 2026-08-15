-- WO-046: dead-letter store for canonical audit events that fail
-- enrichment/PHI-scrub/persistence, modeled directly on
-- telemetry_dead_letter_events (migration 034) — same shape, same RLS +
-- tenant-context-guard wiring, since both are "this event could not be
-- durably processed, hold it for manual review and replay" stores.
CREATE TABLE audit_events_dlq (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    event_id       UUID NOT NULL,
    payload        JSONB NOT NULL,
    error_message  TEXT NOT NULL,
    retry_count    INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_dlq_tenant_created ON audit_events_dlq (tenant_id, created_at);

SELECT enable_tenant_isolation('audit_events_dlq');
SELECT attach_tenant_context_guard('audit_events_dlq');

GRANT SELECT, INSERT, DELETE ON audit_events_dlq TO ams_app;
