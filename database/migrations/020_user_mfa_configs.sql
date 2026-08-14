-- WO-021 (MFA Step-Up Authentication): per-user TOTP enrollment. The TOTP
-- secret and each backup code are Restricted-tier credential material —
-- BYOK-encrypted (WO-015 EncryptionService) before storage, same pattern
-- migration 018 already established for tenant_sso_configs'
-- oidc_client_secret. Backup codes are stored as a JSONB array of
-- {ciphertext, iv, authTag, encryptedDataKey, keyVersion, used} objects
-- (base64-encoded binary fields) rather than 10 separate columns, since
-- the count is fixed by this WO's own spec (10) but modeling it as rows
-- would need its own child table for what's really one atomic unit
-- issued and consumed together per user.

CREATE TABLE user_mfa_configs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    tenant_id                   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    totp_secret_ciphertext      BYTEA NOT NULL,
    totp_secret_iv              BYTEA NOT NULL,
    totp_secret_auth_tag        BYTEA NOT NULL,
    totp_secret_encrypted_dek   BYTEA NOT NULL,
    totp_secret_key_version     INT NOT NULL,
    -- Replay protection: the last TOTP period number that was
    -- successfully consumed for this user, so the SAME valid code can't
    -- be submitted twice within its own validity window/skew tolerance.
    last_used_period            BIGINT,
    backup_codes                JSONB NOT NULL DEFAULT '[]'::jsonb,
    enrolled_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_mfa_configs_tenant_id ON user_mfa_configs (tenant_id, user_id);

SELECT enable_tenant_isolation('user_mfa_configs');
SELECT attach_tenant_context_guard('user_mfa_configs');

GRANT SELECT, INSERT, UPDATE ON user_mfa_configs TO ams_app;
