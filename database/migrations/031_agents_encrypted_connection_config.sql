-- WO-031: agent connection credentials (connection_config — API keys,
-- endpoint URLs with embedded secrets, etc.) are Restricted-tier
-- credential material (WO-016's classification rules), same tier as
-- WO-018's OIDC client secret and WO-021's TOTP secret — BYOK-encrypted
-- (WO-015's EncryptionService) before storage, never a plain JSONB
-- column. migration 004 created this table before BYOK encryption
-- (WO-015) existed; this migration brings it in line with every other
-- credential-bearing column added since.
ALTER TABLE agents
    DROP COLUMN connection_config,
    ADD COLUMN connection_config_ciphertext    BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN connection_config_iv            BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN connection_config_auth_tag      BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN connection_config_encrypted_dek BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN connection_config_key_version   INT NOT NULL DEFAULT 0,
    -- Non-sensitive, freely queryable agent metadata (display hints,
    -- tags, etc.) — separate from connection_config, which is exclusively
    -- credential material. This WO's own acceptance criteria call for
    -- "metadata management" but migration 004 never added the column.
    ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The defaults above exist ONLY to let this ALTER succeed against a
-- table that might already have rows (none in practice pre-launch) —
-- every row the application itself ever inserts always supplies real
-- encrypted values via AgentsService, never these placeholders.
ALTER TABLE agents
    ALTER COLUMN connection_config_ciphertext DROP DEFAULT,
    ALTER COLUMN connection_config_iv DROP DEFAULT,
    ALTER COLUMN connection_config_auth_tag DROP DEFAULT,
    ALTER COLUMN connection_config_encrypted_dek DROP DEFAULT,
    ALTER COLUMN connection_config_key_version DROP DEFAULT;
