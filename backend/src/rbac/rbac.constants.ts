// WO-023: compile-time-safe references to the five canonical platform
// roles, the 8 permission feature areas, the permission actions used
// across them, and the full permission name list — all mirroring the
// seed data in database/migrations/024_rbac_permission_matrix.sql
// exactly. Keep these two in sync; a unit test
// (test/rbac/rbac-definition.service.test.ts) asserts the seeded
// database matches this list so drift is caught, not silently ignored.

// A const object + derived union type, NOT a real `enum` — enums are
// nominal types in TypeScript, so a call site passing the plain string
// literal "agent_operator" (as most of this codebase's existing call
// sites do, predating this file) would fail to compile against a real
// enum-typed parameter. This gives the same PlatformRoleName.TEAM_LEAD
// ergonomics while staying structurally a string, assignable from any
// matching literal.
export const PlatformRoleName = {
  PLATFORM_ADMIN: "platform_admin",
  TEAM_LEAD: "team_lead",
  AGENT_OPERATOR: "agent_operator",
  FINANCE_MANAGER: "finance_manager",
  COMPLIANCE_OFFICER: "compliance_officer",
} as const;
export type PlatformRoleName = (typeof PlatformRoleName)[keyof typeof PlatformRoleName];

export const ALL_PLATFORM_ROLE_NAMES: PlatformRoleName[] = Object.values(PlatformRoleName);

export enum FeatureArea {
  AGENT_MANAGEMENT = "agent_management",
  CREDIT_MANAGEMENT = "credit_management",
  AUDIT_ACCESS = "audit_access",
  GOVERNANCE = "governance",
  USER_MANAGEMENT = "user_management",
  TENANT_CONFIGURATION = "tenant_configuration",
  DATA_RETENTION = "data_retention",
  REPORTING = "reporting",
}

export enum PermissionAction {
  CREATE = "create",
  READ = "read",
  UPDATE = "update",
  DELETE = "delete",
  TRIGGER = "trigger",
  LIFECYCLE_CONTROL = "lifecycle_control",
  VIEW_ALL = "view_all",
  VIEW_ASSIGNED = "view_assigned",
  MANAGE = "manage",
  CONFIGURE = "configure",
  VIEW_ORG = "view_org",
  VIEW_TEAM = "view_team",
  VIEW_PERSONAL = "view_personal",
  VIEW = "view",
  REVIEW = "review",
  APPROVE = "approve",
  ASSIGN = "assign",
  DEACTIVATE = "deactivate",
  TRACK = "track",
  SCHEDULE = "schedule",
  MONITOR = "monitor",
  GENERATE = "generate",
  EXPORT = "export",
}

export enum PermissionName {
  AGENT_CREATE = "agent_management:agent:create",
  AGENT_READ = "agent_management:agent:read",
  AGENT_UPDATE = "agent_management:agent:update",
  AGENT_DELETE = "agent_management:agent:delete",
  AGENT_TRIGGER = "agent_management:agent:trigger",
  AGENT_LIFECYCLE_CONTROL = "agent_management:agent:lifecycle_control",
  AGENT_BULK_LIFECYCLE_CONTROL = "agent_management:agent:bulk_lifecycle_control",
  TRACE_VIEW_ALL = "agent_management:trace:view_all",
  TRACE_VIEW_ASSIGNED = "agent_management:trace:view_assigned",

  CREDIT_ALLOCATION_MANAGE = "credit_management:allocation:manage",
  CREDIT_BUDGET_CONFIGURE = "credit_management:budget:configure",
  CREDIT_OVERAGE_CAP_MANAGE = "credit_management:overage_cap:manage",
  CREDIT_CONSUMPTION_VIEW_ORG = "credit_management:consumption:view_org",
  CREDIT_CONSUMPTION_VIEW_TEAM = "credit_management:consumption:view_team",
  CREDIT_CONSUMPTION_VIEW_PERSONAL = "credit_management:consumption:view_personal",
  CREDIT_FORECAST_VIEW = "credit_management:forecast:view",

  AUDIT_LOGS_VIEW_ORG = "audit_access:logs:view_org",
  AUDIT_LOGS_VIEW_TEAM = "audit_access:logs:view_team",
  AUDIT_PHI_MONITORING_VIEW = "audit_access:phi_monitoring:view",

  GOVERNANCE_APPROVAL_REVIEW = "governance:approval:review",
  GOVERNANCE_APPROVAL_APPROVE = "governance:approval:approve",
  GOVERNANCE_POLICY_CONFIGURE = "governance:policy:configure",
  GOVERNANCE_ESCALATION_MANAGE = "governance:escalation:manage",

  USER_CREATE = "user_management:user:create",
  USER_READ = "user_management:user:read",
  USER_UPDATE = "user_management:user:update",
  USER_DEACTIVATE = "user_management:user:deactivate",
  ROLE_ASSIGN = "user_management:role:assign",
  GROUP_MAPPING_MANAGE = "user_management:group_mapping:manage",
  SCIM_TOKEN_MANAGE = "user_management:scim_token:manage",

  TENANT_SETTINGS_MANAGE = "tenant_configuration:settings:manage",
  TENANT_SSO_CONFIGURE = "tenant_configuration:sso:configure",
  TENANT_MFA_POLICY_CONFIGURE = "tenant_configuration:mfa_policy:configure",
  TENANT_SESSION_POLICY_CONFIGURE = "tenant_configuration:session_policy:configure",
  TENANT_RBAC_MANAGE = "tenant_configuration:rbac:manage",

  DATA_RETENTION_POLICY_MANAGE = "data_retention:policy:manage",
  DATA_RETENTION_DSR_TRACK = "data_retention:dsr:track",
  DATA_RETENTION_DELETION_SCHEDULE = "data_retention:deletion:schedule",
  DATA_RETENTION_PHI_LIFECYCLE_MONITOR = "data_retention:phi_lifecycle:monitor",

  REPORTING_COMPLIANCE_REPORT_GENERATE = "reporting:compliance_report:generate",
  REPORTING_CONSUMPTION_REPORT_GENERATE = "reporting:consumption_report:generate",
  REPORTING_TEAM_ALERT_CONFIGURE = "reporting:team_alert:configure",
  REPORTING_AUDIT_SUMMARY_EXPORT = "reporting:audit_summary:export",
}

export const ALL_PERMISSION_NAMES: PermissionName[] = Object.values(PermissionName);
