-- WO-020 (Redis-Backed Session Management): per-tenant idle/absolute
-- session timeout configuration. Session STATE itself (the sessions
-- themselves, ephemeral by nature) lives in the session store (Redis in
-- production, in-memory for dev/test/single-instance — see
-- session-store.port.ts) — this table is durable POLICY configuration
-- only, same tenant_id-unique-row shape as tenant_sso_configs (WO-018)
-- and tenant_key_metadata (WO-015).

CREATE TABLE tenant_session_policies (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
    idle_timeout_seconds    INT NOT NULL DEFAULT 1800 CHECK (idle_timeout_seconds BETWEEN 300 AND 3600),
    absolute_timeout_seconds INT NOT NULL DEFAULT 28800 CHECK (absolute_timeout_seconds BETWEEN 3600 AND 86400),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT enable_tenant_isolation('tenant_session_policies');
SELECT attach_tenant_context_guard('tenant_session_policies');

GRANT SELECT, INSERT, UPDATE ON tenant_session_policies TO ams_app;
