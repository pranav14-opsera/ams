-- WO-025: SCIM tokens are "generated and managed by Platform
-- Administrators" per this WO's own acceptance criteria — adds the one
-- new permission this requires to the WO-023 matrix, granted only to
-- platform_admin. Existing tenants provisioned before this migration
-- won't have this permission in their rbac_policies row yet (that
-- snapshot is copied once, at provisioning time, by design — see
-- migration 024's comment) — a real production rollout would need a
-- backfill step, out of scope for this fresh, no-production-tenants-yet
-- codebase.
INSERT INTO permissions (name, display_name, description, feature_area, resource_type, action) VALUES
    ('user_management:scim_token:manage', 'Manage SCIM Tokens', 'Generate, list, and revoke a tenant''s SCIM provisioning bearer tokens.', 'user_management', 'scim_token', 'manage');

INSERT INTO role_permissions (role_name, permission_name) VALUES
    ('platform_admin', 'user_management:scim_token:manage');
