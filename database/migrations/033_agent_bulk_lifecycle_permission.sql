-- WO-033: bulk lifecycle operations are explicitly gated behind their own
-- permission ("agent:bulk-lifecycle"), separate from WO-032's single-agent
-- agent_management:agent:lifecycle_control — a much larger blast radius
-- (up to 100 agents in one call) warrants a distinct grant rather than
-- silently piggybacking on the single-agent permission. Same
-- "add-one-permission-via-a-later-migration" pattern as migration 028's
-- scim_token:manage. platform_admin only, same as lifecycle_control.
INSERT INTO permissions (name, display_name, description, feature_area, resource_type, action) VALUES
    ('agent_management:agent:bulk_lifecycle_control', 'Bulk Control Agent Lifecycle', 'Pause, resume, retire, or decommission up to 100 agents in a single call.', 'agent_management', 'agent', 'bulk_lifecycle_control');

INSERT INTO role_permissions (role_name, permission_name) VALUES
    ('platform_admin', 'agent_management:agent:bulk_lifecycle_control');
