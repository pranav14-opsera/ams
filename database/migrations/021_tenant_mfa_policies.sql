-- WO-021: per-tenant MFA step-up policy. Restricted/Confidential always
-- have SOME MFA requirement per this WO's own description ("Restricted
-- data always requires MFA", "Confidential requires MFA on first access
-- per session") — only the elevation DURATION for Restricted and the
-- Internal/Public opt-in are actually tenant-configurable, but all four
-- are modeled as columns for a uniform, explainable policy row rather
-- than special-casing two tiers as "not configurable" in application
-- code while still keeping their columns here.

CREATE TABLE tenant_mfa_policies (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
    restricted_elevation_minutes    INT NOT NULL DEFAULT 60 CHECK (restricted_elevation_minutes BETWEEN 5 AND 480),
    require_mfa_for_internal        BOOLEAN NOT NULL DEFAULT false,
    require_mfa_for_public          BOOLEAN NOT NULL DEFAULT false,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT enable_tenant_isolation('tenant_mfa_policies');
SELECT attach_tenant_context_guard('tenant_mfa_policies');

GRANT SELECT, INSERT, UPDATE ON tenant_mfa_policies TO ams_app;
