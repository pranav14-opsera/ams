# RBAC Permission Matrix (WO-023)

This is the canonical, platform-wide Five-Tier RBAC permission matrix.
It resolves Open Question #2 from the PRD and the PRD/Architecture role
naming inconsistency: the **Architecture's domain-specific role names**
below are canonical, not the PRD's generic Owner/Admin/Manager/Member/Guest.

Seeded via [`database/migrations/024_rbac_permission_matrix.sql`](../database/migrations/024_rbac_permission_matrix.sql)
into the global `roles`/`permissions`/`role_permissions` tables, and copied
into each tenant's own `rbac_policies` rows at provisioning time
(`PostgresRbacService.applyDefaultPolicies`). TypeScript constants mirroring
this table live in [`backend/src/rbac/rbac.constants.ts`](../backend/src/rbac/rbac.constants.ts).
A test (`backend/test/rbac/rbac-definition.service.test.ts`) parses the
table below and asserts it matches the seeded database exactly, so this
document cannot silently drift from what's actually enforced.

## Roles

| Role | Display Name | Scope | Summary |
|---|---|---|---|
| `platform_admin` | Platform Administrator | organization | Broadest authority: agent lifecycle, user/RBAC management, tenant configuration, full audit visibility. No finance-specific budget/overage authority. |
| `team_lead` | Team Lead | team | Manages agents and views consumption/audit activity scoped to their own team only. |
| `agent_operator` | Agent Operator | personal | Operates assigned agents day to day. No administrative capability. |
| `finance_manager` | Finance Manager | organization | Organization-wide financial authority. No agent lifecycle or RBAC authority. |
| `compliance_officer` | Compliance Officer | organization | Organization-wide compliance authority. No agent lifecycle or credit management authority. |

## Permission Matrix

| Permission | platform_admin | team_lead | agent_operator | finance_manager | compliance_officer |
|---|---|---|---|---|---|
| agent_management:agent:create | ✓ | | | | |
| agent_management:agent:read | ✓ | ✓ | | | |
| agent_management:agent:update | ✓ | ✓ | | | |
| agent_management:agent:delete | ✓ | | | | |
| agent_management:agent:trigger | ✓ | ✓ | ✓ | | |
| agent_management:agent:lifecycle_control | ✓ | | | | |
| agent_management:agent:bulk_lifecycle_control | ✓ | | | | |
| agent_management:trace:view_all | ✓ | | | | |
| agent_management:trace:view_assigned | | | ✓ | | |
| credit_management:allocation:manage | ✓ | | | ✓ | |
| credit_management:budget:configure | | | | ✓ | |
| credit_management:overage_cap:manage | | | | ✓ | |
| credit_management:consumption:view_org | | | | ✓ | |
| credit_management:consumption:view_team | | ✓ | | | |
| credit_management:consumption:view_personal | | | ✓ | | |
| credit_management:forecast:view | | | | ✓ | |
| audit_access:logs:view_org | ✓ | | | | ✓ |
| audit_access:logs:view_team | ✓ | ✓ | | | |
| audit_access:phi_monitoring:view | ✓ | | | | ✓ |
| governance:approval:review | | ✓ | | | ✓ |
| governance:approval:approve | | | | | ✓ |
| governance:policy:configure | ✓ | | | | |
| governance:escalation:manage | ✓ | | | | ✓ |
| user_management:user:create | ✓ | | | | |
| user_management:user:read | ✓ | | | | |
| user_management:user:update | ✓ | | | | |
| user_management:user:deactivate | ✓ | | | | |
| user_management:role:assign | ✓ | | | | |
| user_management:group_mapping:manage | ✓ | | | | |
| user_management:scim_token:manage | ✓ | | | | |
| tenant_configuration:settings:manage | ✓ | | | | |
| tenant_configuration:sso:configure | ✓ | | | | |
| tenant_configuration:mfa_policy:configure | ✓ | | | | |
| tenant_configuration:session_policy:configure | ✓ | | | | |
| tenant_configuration:rbac:manage | ✓ | | | | |
| data_retention:policy:manage | | | | | ✓ |
| data_retention:dsr:track | | | | | ✓ |
| data_retention:deletion:schedule | | | | | ✓ |
| data_retention:phi_lifecycle:monitor | | | | | ✓ |
| reporting:compliance_report:generate | | | | | ✓ |
| reporting:consumption_report:generate | | | | ✓ | |
| reporting:team_alert:configure | | ✓ | | | |
| reporting:audit_summary:export | | | | | ✓ |

## Documented scope exclusions (enforced by test)

- **platform_admin** never holds `credit_management:budget:configure` or `credit_management:overage_cap:manage` (finance-specific).
- **team_lead** never holds any `tenant_configuration:*` or `user_management:*` permission (org-wide administrative settings).
- **agent_operator** never holds `agent_management:agent:create`, `:update`, `:delete`, or `:lifecycle_control` (no administrative capability).
- **finance_manager** never holds any `agent_management:*` or `user_management:*`/`tenant_configuration:rbac:manage` permission (no agent lifecycle or RBAC authority).
- **compliance_officer** never holds any `agent_management:*` or `credit_management:*` permission (no agent lifecycle or credit management authority).
