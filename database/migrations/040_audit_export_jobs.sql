-- WO-047: async audit-log export job state machine
-- (pending -> processing -> completed | failed). No existing generic
-- background-job table exists anywhere in this codebase to reuse — this
-- is purpose-built for audit export, following the same RLS/tenant-
-- isolation wiring as every other tenant-scoped table.
CREATE TABLE audit_export_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    requested_by      UUID REFERENCES users (id) ON DELETE SET NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    filters           JSONB NOT NULL DEFAULT '{}'::jsonb,
    record_count      INT,
    storage_key       TEXT,
    download_url      TEXT,
    download_url_expires_at TIMESTAMPTZ,
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

CREATE INDEX idx_audit_export_jobs_tenant_created ON audit_export_jobs (tenant_id, created_at DESC);

SELECT enable_tenant_isolation('audit_export_jobs');
SELECT attach_tenant_context_guard('audit_export_jobs');

GRANT SELECT, INSERT, UPDATE ON audit_export_jobs TO ams_app;
