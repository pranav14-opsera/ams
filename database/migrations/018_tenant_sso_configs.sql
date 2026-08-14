-- WO-018 (Auth Service: SAML 2.0 and OIDC SSO): one SSO configuration per
-- tenant. UNIQUE(tenant_id) matches this WO's own acceptance criteria
-- ("Tenant administrators can configure their IdP") — a tenant has
-- exactly one active IdP config, not many.

CREATE TABLE tenant_sso_configs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
    protocol            TEXT NOT NULL CHECK (protocol IN ('saml', 'oidc')),

    -- SAML fields (NULL when protocol = 'oidc')
    saml_metadata_url   TEXT,
    saml_entity_id      TEXT,
    saml_cert_pem       TEXT, -- cached from the metadata URL; refreshed on the interval below

    -- OIDC fields (NULL when protocol = 'saml')
    oidc_discovery_url  TEXT,
    oidc_client_id      TEXT,
    -- Client secret is itself Restricted-tier (WO-016) credential material —
    -- BYOK-encrypted (WO-015 EncryptionService) before storage, never
    -- plaintext. Columns hold the envelope-encryption output, not the secret.
    oidc_client_secret_ciphertext   BYTEA,
    oidc_client_secret_iv           BYTEA,
    oidc_client_secret_auth_tag     BYTEA,
    oidc_client_secret_encrypted_dek BYTEA,
    oidc_client_secret_key_version  INT,

    metadata_refresh_interval_hours INT NOT NULL DEFAULT 24,
    metadata_last_fetched_at        TIMESTAMPTZ,

    -- Optimistic locking (implementation_steps: "version column for
    -- optimistic locking") — concurrent admin edits to the same tenant's
    -- SSO config must not silently clobber each other.
    version             INT NOT NULL DEFAULT 1,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT saml_fields_required_for_saml_protocol
        CHECK (protocol <> 'saml' OR (saml_metadata_url IS NOT NULL AND saml_entity_id IS NOT NULL)),
    CONSTRAINT oidc_fields_required_for_oidc_protocol
        CHECK (protocol <> 'oidc' OR (oidc_discovery_url IS NOT NULL AND oidc_client_id IS NOT NULL))
);

SELECT enable_tenant_isolation('tenant_sso_configs');
SELECT attach_tenant_context_guard('tenant_sso_configs');

GRANT SELECT, INSERT, UPDATE ON tenant_sso_configs TO ams_app;
-- No DELETE: an SSO config is deactivated (a future status column /
-- WO-020+ concern), not removed, so an audit trail of what an IdP
-- config looked like is never lost outright. tenant_id CASCADE from
-- tenants still applies for genuine tenant offboarding.
