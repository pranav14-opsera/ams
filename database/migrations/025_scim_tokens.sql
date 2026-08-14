-- WO-025 (SCIM 2.0 Provisioning): per-tenant bearer tokens an IdP (Okta,
-- Entra ID) presents to authenticate SCIM requests. Only the SHA-256
-- digest is stored — same "never store the raw secret" pattern as
-- refresh tokens — the raw token is returned exactly once, at creation.
--
-- Deliberately NOT wrapped in enable_tenant_isolation()/RLS: a SCIM
-- request arrives with nothing but a bearer token and no tenant context
-- whatsoever (that's the whole point — ScimAuthGuard's job is to
-- DISCOVER the tenant from the token), so the lookup query
-- (`WHERE token_hash = $1`) necessarily runs before app.current_tenant
-- can be set — the same structural reason `tenants` itself isn't
-- tenant-scoped (TenantContextMiddleware needs to read it to validate a
-- JWT's tenant before any tenant context exists). The token_hash unique
-- index makes this an O(1) point lookup, not a cross-tenant table scan,
-- and application code immediately sets app.current_tenant from the ONE
-- matched row before any other query runs.
CREATE TABLE scim_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    token_hash   BYTEA NOT NULL UNIQUE,
    description  TEXT,
    created_by   UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX idx_scim_tokens_tenant_id ON scim_tokens (tenant_id);

GRANT SELECT, INSERT, UPDATE ON scim_tokens TO ams_app;
