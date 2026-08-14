-- Data Subject Rights requests (WO-098): access, deletion, portability,
-- correction. SLA-tracked per GDPR/CCPA.
CREATE TABLE dsr_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    subject_email   TEXT NOT NULL,
    request_type    TEXT NOT NULL CHECK (request_type IN ('access', 'deletion', 'portability', 'correction')),
    status          TEXT NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'verifying', 'in_progress', 'completed', 'rejected')),
    sla_due_at      TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,
    handled_by      UUID REFERENCES users (id) ON DELETE SET NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dsr_requests_tenant_status_sla ON dsr_requests (tenant_id, status, sla_due_at);
SELECT enable_tenant_isolation('dsr_requests');
GRANT SELECT, INSERT, UPDATE ON dsr_requests TO ams_app;
