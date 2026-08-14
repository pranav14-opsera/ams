-- WO-022 (JIT User Provisioning): per-tenant mapping from an IdP group
-- claim to a single platform role. A user's SAML/OIDC assertion can carry
-- multiple group memberships that map to multiple rows here; resolution
-- picks exactly ONE role — the matching row with the lowest `priority`
-- value wins (priority 0 outranks priority 100), so a tenant can express
-- "admins group wins over generic staff group" without ambiguity. No
-- match at all is deny-by-default: the user is provisioned/updated with
-- a NULL role rather than inheriting any implicit default.

CREATE TABLE group_role_mappings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    idp_group      TEXT NOT NULL,
    platform_role  TEXT NOT NULL CHECK (platform_role IN ('platform_admin', 'compliance_officer', 'finance_manager', 'team_lead', 'agent_operator')),
    priority       INT NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, idp_group)
);

CREATE INDEX idx_group_role_mappings_tenant_id ON group_role_mappings (tenant_id, priority);

SELECT enable_tenant_isolation('group_role_mappings');
SELECT attach_tenant_context_guard('group_role_mappings');

GRANT SELECT, INSERT, UPDATE, DELETE ON group_role_mappings TO ams_app;
