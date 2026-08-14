-- WO-025 (SCIM 2.0 Provisioning): actual per-user membership rosters for
-- a SCIM Group. group_role_mappings (WO-022) only defines "this IdP
-- group name maps to this platform role" — it has no concept of WHO is
-- currently in that group. A SCIM Group (RFC 7644) IS a
-- group_role_mapping row from this platform's perspective (its
-- displayName is the idp_group, and this platform's own
-- vendor-extension attributes carry platformRole/priority) — this table
-- is its members list.
CREATE TABLE scim_group_memberships (
    scim_group_id UUID NOT NULL REFERENCES group_role_mappings (id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (scim_group_id, user_id)
);

CREATE INDEX idx_scim_group_memberships_user ON scim_group_memberships (tenant_id, user_id);

SELECT enable_tenant_isolation('scim_group_memberships');
SELECT attach_tenant_context_guard('scim_group_memberships');

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_group_memberships TO ams_app;
