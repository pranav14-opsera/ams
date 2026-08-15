-- WO-034: adapter telemetry ingestion foundation.
--
-- 1. Per-agent HMAC shared secret (X-Signature-256 verification on
--    POST /api/v1/adapters/*/telemetry) is Restricted-tier credential
--    material — BYOK-encrypted (WO-015's EncryptionService), same
--    ciphertext/iv/auth_tag/encrypted_dek/key_version shape as
--    connection_config (migration 031), never a plaintext column.
ALTER TABLE agents
    ADD COLUMN hmac_secret_ciphertext    BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN hmac_secret_iv            BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN hmac_secret_auth_tag      BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN hmac_secret_encrypted_dek BYTEA NOT NULL DEFAULT ''::bytea,
    ADD COLUMN hmac_secret_key_version   INT NOT NULL DEFAULT 0;

ALTER TABLE agents
    ALTER COLUMN hmac_secret_ciphertext DROP DEFAULT,
    ALTER COLUMN hmac_secret_iv DROP DEFAULT,
    ALTER COLUMN hmac_secret_auth_tag DROP DEFAULT,
    ALTER COLUMN hmac_secret_encrypted_dek DROP DEFAULT,
    ALTER COLUMN hmac_secret_key_version DROP DEFAULT;

-- 2. Dead-letter queue for telemetry events that pass validation but
-- fail Kafka publication (broker unreachable, etc.) — this WO's own
-- implementation_steps call for a DLQ on the producer. A real local
-- Postgres table, not a stub: genuinely durable, genuinely queryable for
-- replay, and testable in this sandbox (no local Kafka broker/Docker
-- available — see TELEMETRY_PIPELINE.md for the same class of
-- documented environment limitation as WO-026/028's Terraform gap).
CREATE TABLE telemetry_dead_letter_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id       UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    event_id       UUID NOT NULL,
    payload        JSONB NOT NULL,
    publish_error  TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_telemetry_dlq_tenant_agent ON telemetry_dead_letter_events (tenant_id, agent_id, created_at);

SELECT enable_tenant_isolation('telemetry_dead_letter_events');
SELECT attach_tenant_context_guard('telemetry_dead_letter_events');

GRANT SELECT, INSERT, DELETE ON telemetry_dead_letter_events TO ams_app;
