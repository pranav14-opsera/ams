-- WO-015 (BYOK Encryption Key Management Service): durable record of each
-- tenant's key lifecycle state. The actual key material lives in KMS (or
-- the in-memory mock adapter, see backend/src/tenants/ports) — this table
-- exists because a real KMS's DescribeKey doesn't give you a convenient,
-- queryable history of an application's own rotation/deletion decisions,
-- the same reason a real system keeps its own metadata table alongside a
-- managed KMS. Rotation/deletion-schedule/deletion-cancel events are also
-- recorded as audit_events rows (actor + before/after) — this table is
-- current-state only, not a history log.

CREATE TABLE tenant_key_metadata (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
    key_arn             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_deletion', 'disabled')),
    current_version     INT NOT NULL DEFAULT 1,
    rotation_due_at      TIMESTAMPTZ NOT NULL,
    pending_deletion_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE(tenant_id) above already gives a tenant_id-leading index for
-- free; this composite index matches this table's actual query pattern
-- (WO-015's scheduled-deletion job: "find keys whose 7-day wait has
-- elapsed").
CREATE INDEX idx_tenant_key_metadata_status_pending_deletion
    ON tenant_key_metadata (tenant_id, status, pending_deletion_at);

SELECT enable_tenant_isolation('tenant_key_metadata');
SELECT attach_tenant_context_guard('tenant_key_metadata');

GRANT SELECT, INSERT, UPDATE ON tenant_key_metadata TO ams_app;
-- No DELETE: a tenant's key metadata is superseded (status set to
-- 'disabled' once truly deleted), never removed, so its history remains
-- inspectable — same append-only-by-convention reasoning as audit_events,
-- just without a hash chain since this table only ever holds current state.
