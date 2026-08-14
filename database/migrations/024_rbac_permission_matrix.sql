-- WO-023: the canonical, tenant-independent Five-Tier RBAC permission
-- matrix. This is deliberately a SEPARATE set of tables from
-- `rbac_policies` (migration 010): `rbac_policies` is the per-tenant,
-- mutable grant a tenant actually has today (queried on every token
-- mint); `roles`/`permissions`/`role_permissions` here are the
-- platform-wide, admin-curated DEFINITION of what each role means,
-- documented for stakeholder review (docs/rbac-permission-matrix.md)
-- and re-usable by any UI that needs to render "what does Team Lead
-- mean" without depending on any one tenant's row. Tenant provisioning
-- (WO-013's saga, via PostgresRbacService.applyDefaultPolicies) copies
-- this canonical matrix into each new tenant's rbac_policies rows —
-- that's what actually makes getPermissionsForRoles() return real
-- grants instead of the `[]` placeholder WO-013/WO-019 left behind.

CREATE TABLE roles (
    name         TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description  TEXT NOT NULL,
    scope        TEXT NOT NULL CHECK (scope IN ('organization', 'team', 'personal')),
    is_system    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    -- feature_area:resource:action, e.g. "agent_management:agent:create" —
    -- matches the convention already used for audit_events.action strings
    -- elsewhere in this codebase.
    name          TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    description   TEXT NOT NULL,
    feature_area  TEXT NOT NULL CHECK (feature_area IN (
        'agent_management', 'credit_management', 'audit_access', 'governance',
        'user_management', 'tenant_configuration', 'data_retention', 'reporting'
    )),
    resource_type TEXT NOT NULL,
    action        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
    role_name       TEXT NOT NULL REFERENCES roles (name) ON DELETE CASCADE,
    permission_name TEXT NOT NULL REFERENCES permissions (name) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (role_name, permission_name)
);

CREATE INDEX idx_role_permissions_permission_name ON role_permissions (permission_name);

-- These are global, platform-curated definitions, not tenant data — no
-- RLS here, deliberately, matching how e.g. classification-handling
-- rules (WO-016) are frozen platform constants rather than per-tenant rows.
GRANT SELECT ON roles, permissions, role_permissions TO ams_app;

-- ---------------------------------------------------------------------
-- Seed: the five canonical roles. Architecture's domain-specific naming
-- is canonical per this WO's own description (resolving the PRD's
-- generic Owner/Admin/Manager/Member/Guest naming inconsistency).
-- ---------------------------------------------------------------------
INSERT INTO roles (name, display_name, description, scope) VALUES
    ('platform_admin', 'Platform Administrator', 'Broadest platform authority: agent lifecycle, user/RBAC management, tenant configuration, full audit visibility. Does not hold finance-specific budget/overage authority.', 'organization'),
    ('team_lead', 'Team Lead', 'Manages agents and views consumption/audit activity scoped to their own team only; no organization-wide administrative authority.', 'team'),
    ('agent_operator', 'Agent Operator', 'Operates assigned agents day to day: triggers runs, views personal usage, inspects traces for agents assigned to them. No administrative capability.', 'personal'),
    ('finance_manager', 'Finance Manager', 'Organization-wide financial authority: credit allocation, budget and overage caps, consumption forecasting and reporting. No agent lifecycle or RBAC authority.', 'organization'),
    ('compliance_officer', 'Compliance Officer', 'Organization-wide compliance authority: full audit and PHI-access-monitoring visibility, data retention policy, DSR tracking, compliance reporting. No agent lifecycle or credit management authority.', 'organization');

-- ---------------------------------------------------------------------
-- Seed: 41 permissions across the 8 required feature areas.
-- ---------------------------------------------------------------------
INSERT INTO permissions (name, display_name, description, feature_area, resource_type, action) VALUES
    ('agent_management:agent:create',            'Create Agent',                          'Create a new agent definition.',                          'agent_management', 'agent', 'create'),
    ('agent_management:agent:read',               'View Agent',                            'View an agent''s configuration and status.',              'agent_management', 'agent', 'read'),
    ('agent_management:agent:update',             'Update Agent',                          'Modify an agent''s configuration.',                       'agent_management', 'agent', 'update'),
    ('agent_management:agent:delete',             'Delete Agent',                          'Permanently remove an agent definition.',                 'agent_management', 'agent', 'delete'),
    ('agent_management:agent:trigger',            'Trigger Agent Operation',               'Invoke/run an agent.',                                    'agent_management', 'agent', 'trigger'),
    ('agent_management:agent:lifecycle_control',  'Control Agent Lifecycle',               'Pause, resume, or roll back an agent.',                   'agent_management', 'agent', 'lifecycle_control'),
    ('agent_management:trace:view_all',           'View All Trace Explorer Data',          'View trace/execution data for every agent org-wide.',     'agent_management', 'trace', 'view_all'),
    ('agent_management:trace:view_assigned',      'View Assigned-Agent Trace Data',        'View trace/execution data for agents assigned to the caller only.', 'agent_management', 'trace', 'view_assigned'),

    ('credit_management:allocation:manage',       'Manage Credit Allocation',              'Allocate platform credit balances.',                      'credit_management', 'allocation', 'manage'),
    ('credit_management:budget:configure',        'Configure Budget Caps',                 'Set organization or team budget caps.',                   'credit_management', 'budget', 'configure'),
    ('credit_management:overage_cap:manage',      'Manage Overage Caps',                   'Configure overage/hard-stop caps.',                       'credit_management', 'overage_cap', 'manage'),
    ('credit_management:consumption:view_org',    'View Org-Wide Consumption',             'View credit consumption across the whole tenant.',        'credit_management', 'consumption', 'view_org'),
    ('credit_management:consumption:view_team',   'View Team Consumption',                 'View credit consumption for the caller''s own team.',     'credit_management', 'consumption', 'view_team'),
    ('credit_management:consumption:view_personal','View Personal Usage',                  'View the caller''s own usage only.',                      'credit_management', 'consumption', 'view_personal'),
    ('credit_management:forecast:view',           'View Consumption Forecast',             'View projected future credit consumption.',               'credit_management', 'forecast', 'view'),

    ('audit_access:logs:view_org',                'View Org-Wide Audit Logs',              'View audit_events across the whole tenant.',              'audit_access', 'logs', 'view_org'),
    ('audit_access:logs:view_team',               'View Team Audit Logs',                  'View audit_events scoped to the caller''s own team.',     'audit_access', 'logs', 'view_team'),
    ('audit_access:phi_monitoring:view',          'View PHI Access Monitoring',             'View who accessed PHI/Restricted-tier data and when.',    'audit_access', 'phi_monitoring', 'view'),

    ('governance:approval:review',                'Review Governance Approvals',           'Review a pending governance approval request.',           'governance', 'approval', 'review'),
    ('governance:approval:approve',               'Approve Governance Requests',           'Grant final approval on a governance request.',           'governance', 'approval', 'approve'),
    ('governance:policy:configure',               'Configure Governance Policy',           'Configure organization governance policy.',               'governance', 'policy', 'configure'),
    ('governance:escalation:manage',               'Manage Governance Escalations',        'Manage escalation of a stalled/contested governance item.', 'governance', 'escalation', 'manage'),

    ('user_management:user:create',               'Create User',                          'Create a new platform user.',                             'user_management', 'user', 'create'),
    ('user_management:user:read',                 'View User',                            'View a platform user''s account details.',                'user_management', 'user', 'read'),
    ('user_management:user:update',               'Update User',                          'Modify a platform user''s account details.',              'user_management', 'user', 'update'),
    ('user_management:user:deactivate',           'Deactivate User',                       'Deactivate a platform user''s account.',                  'user_management', 'user', 'deactivate'),
    ('user_management:role:assign',               'Assign Platform Role',                  'Assign or change a user''s platform role.',               'user_management', 'role', 'assign'),
    ('user_management:group_mapping:manage',      'Manage IdP Group Mappings',             'Manage WO-022 IdP-group-to-role mappings.',               'user_management', 'group_mapping', 'manage'),

    ('tenant_configuration:settings:manage',      'Manage Tenant Settings',                'Manage general tenant configuration settings.',           'tenant_configuration', 'settings', 'manage'),
    ('tenant_configuration:sso:configure',        'Configure SSO',                         'Configure the tenant''s SAML/OIDC SSO integration.',      'tenant_configuration', 'sso', 'configure'),
    ('tenant_configuration:mfa_policy:configure', 'Configure MFA Policy',                  'Configure the tenant''s MFA step-up policy.',             'tenant_configuration', 'mfa_policy', 'configure'),
    ('tenant_configuration:session_policy:configure', 'Configure Session Policy',          'Configure the tenant''s session idle/absolute timeouts.', 'tenant_configuration', 'session_policy', 'configure'),
    ('tenant_configuration:rbac:manage',          'Manage RBAC Assignments',               'Manage which roles exist and their assignments for the tenant.', 'tenant_configuration', 'rbac', 'manage'),

    ('data_retention:policy:manage',              'Manage Data Retention Policy',          'Configure data retention/expiry policy.',                 'data_retention', 'policy', 'manage'),
    ('data_retention:dsr:track',                  'Track Data Subject Requests',           'Track and manage Data Subject Request fulfillment.',      'data_retention', 'dsr', 'track'),
    ('data_retention:deletion:schedule',          'Schedule Data Deletion',                'Schedule data for permanent deletion.',                   'data_retention', 'deletion', 'schedule'),
    ('data_retention:phi_lifecycle:monitor',      'Monitor PHI Data Lifecycle',            'Monitor PHI data from creation through scheduled deletion.', 'data_retention', 'phi_lifecycle', 'monitor'),

    ('reporting:compliance_report:generate',      'Generate Compliance Report',            'Generate a compliance/regulatory report.',                'reporting', 'compliance_report', 'generate'),
    ('reporting:consumption_report:generate',     'Generate Consumption Report',           'Generate a credit consumption report.',                   'reporting', 'consumption_report', 'generate'),
    ('reporting:team_alert:configure',            'Configure Team Alerts',                 'Configure alerting thresholds for the caller''s own team.', 'reporting', 'team_alert', 'configure'),
    ('reporting:audit_summary:export',            'Export Audit Summary Report',           'Export a summarized audit report.',                       'reporting', 'audit_summary', 'export');

-- ---------------------------------------------------------------------
-- Seed: the role -> permission matrix itself.
-- ---------------------------------------------------------------------
INSERT INTO role_permissions (role_name, permission_name) VALUES
    -- platform_admin: broad agent/user/tenant authority, full audit visibility,
    -- but explicitly NOT finance-specific budget/overage/forecast permissions.
    ('platform_admin', 'agent_management:agent:create'),
    ('platform_admin', 'agent_management:agent:read'),
    ('platform_admin', 'agent_management:agent:update'),
    ('platform_admin', 'agent_management:agent:delete'),
    ('platform_admin', 'agent_management:agent:trigger'),
    ('platform_admin', 'agent_management:agent:lifecycle_control'),
    ('platform_admin', 'agent_management:trace:view_all'),
    ('platform_admin', 'credit_management:allocation:manage'),
    ('platform_admin', 'audit_access:logs:view_org'),
    ('platform_admin', 'audit_access:logs:view_team'),
    ('platform_admin', 'audit_access:phi_monitoring:view'),
    ('platform_admin', 'governance:policy:configure'),
    ('platform_admin', 'governance:escalation:manage'),
    ('platform_admin', 'user_management:user:create'),
    ('platform_admin', 'user_management:user:read'),
    ('platform_admin', 'user_management:user:update'),
    ('platform_admin', 'user_management:user:deactivate'),
    ('platform_admin', 'user_management:role:assign'),
    ('platform_admin', 'user_management:group_mapping:manage'),
    ('platform_admin', 'tenant_configuration:settings:manage'),
    ('platform_admin', 'tenant_configuration:sso:configure'),
    ('platform_admin', 'tenant_configuration:mfa_policy:configure'),
    ('platform_admin', 'tenant_configuration:session_policy:configure'),
    ('platform_admin', 'tenant_configuration:rbac:manage'),

    -- team_lead: team-scoped agent management and visibility only —
    -- explicitly no tenant_configuration or user_management permission.
    ('team_lead', 'agent_management:agent:read'),
    ('team_lead', 'agent_management:agent:update'),
    ('team_lead', 'agent_management:agent:trigger'),
    ('team_lead', 'credit_management:consumption:view_team'),
    ('team_lead', 'audit_access:logs:view_team'),
    ('team_lead', 'governance:approval:review'),
    ('team_lead', 'reporting:team_alert:configure'),

    -- agent_operator: day-to-day operation of assigned agents only — no
    -- create/update/delete/lifecycle_control, no org/team-wide visibility.
    ('agent_operator', 'agent_management:agent:trigger'),
    ('agent_operator', 'agent_management:trace:view_assigned'),
    ('agent_operator', 'credit_management:consumption:view_personal'),

    -- finance_manager: organization-wide financial authority only — no
    -- agent_management or user_management/RBAC permission whatsoever.
    ('finance_manager', 'credit_management:allocation:manage'),
    ('finance_manager', 'credit_management:budget:configure'),
    ('finance_manager', 'credit_management:overage_cap:manage'),
    ('finance_manager', 'credit_management:consumption:view_org'),
    ('finance_manager', 'credit_management:forecast:view'),
    ('finance_manager', 'reporting:consumption_report:generate'),

    -- compliance_officer: organization-wide compliance authority only — no
    -- agent_management or credit_management permission whatsoever.
    ('compliance_officer', 'audit_access:logs:view_org'),
    ('compliance_officer', 'audit_access:phi_monitoring:view'),
    ('compliance_officer', 'governance:approval:review'),
    ('compliance_officer', 'governance:approval:approve'),
    ('compliance_officer', 'governance:escalation:manage'),
    ('compliance_officer', 'data_retention:policy:manage'),
    ('compliance_officer', 'data_retention:dsr:track'),
    ('compliance_officer', 'data_retention:deletion:schedule'),
    ('compliance_officer', 'data_retention:phi_lifecycle:monitor'),
    ('compliance_officer', 'reporting:compliance_report:generate'),
    ('compliance_officer', 'reporting:audit_summary:export');
