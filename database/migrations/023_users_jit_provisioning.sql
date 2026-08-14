-- WO-022 (JIT User Provisioning): `role` is the single platform role
-- resolved from the user's current IdP group claims via
-- group_role_mappings (NULL when no mapping matched — deny-by-default,
-- not "no access change"). `provisioned_via` distinguishes how the user
-- row came to exist, specifically so a SCIM-deprovisioned user
-- ('scim' + status 'inactive') is never silently reactivated by a JIT
-- login racing a delayed SCIM deprovisioning feed — that guard is
-- enforced in application code (JitProvisioningService), this column is
-- just what makes the check possible.

ALTER TABLE users
    ADD COLUMN role           TEXT CHECK (role IN ('platform_admin', 'compliance_officer', 'finance_manager', 'team_lead', 'agent_operator')),
    ADD COLUMN provisioned_via TEXT NOT NULL DEFAULT 'manual' CHECK (provisioned_via IN ('manual', 'jit', 'scim'));
