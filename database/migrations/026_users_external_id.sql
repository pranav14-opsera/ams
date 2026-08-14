-- WO-025 (SCIM 2.0 Provisioning): SCIM's `externalId` — the IdP's own
-- identifier for the user, distinct from `idp_subject` (WO-018/022's
-- SAML NameID / OIDC sub, populated by the SSO login flow). A user can
-- be SCIM-provisioned before ever logging in via SSO, so this cannot
-- reuse idp_subject.
ALTER TABLE users ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_users_tenant_external_id ON users (tenant_id, external_id) WHERE external_id IS NOT NULL;
