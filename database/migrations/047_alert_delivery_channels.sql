-- WO-060: per-tenant delivery channel configuration + the immutable
-- delivery log multi-channel alert delivery produces.

CREATE TABLE webhook_configs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    url                         TEXT NOT NULL,
    enabled                     BOOLEAN NOT NULL DEFAULT true,
    -- HMAC signing secret, BYOK-encrypted the same way agents.connection_config
    -- already is (migration 004/015) — never stored in plaintext.
    secret_ciphertext           BYTEA NOT NULL,
    secret_iv                   BYTEA NOT NULL,
    secret_auth_tag             BYTEA NOT NULL,
    secret_encrypted_dek        BYTEA NOT NULL,
    secret_key_version          INTEGER NOT NULL,
    created_by                  UUID,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_configs_tenant ON webhook_configs (tenant_id);
SELECT enable_tenant_isolation('webhook_configs');

CREATE TABLE email_channel_configs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    recipients   TEXT[] NOT NULL,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_by   UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_channel_configs_tenant ON email_channel_configs (tenant_id);
SELECT enable_tenant_isolation('email_channel_configs');

-- Immutable — one row per (alert_event, channel_type) delivery attempt sequence lives here via repeated INSERTs, never UPDATE/DELETE.
CREATE TABLE alert_delivery_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    alert_event_id  UUID NOT NULL REFERENCES alert_events (id) ON DELETE CASCADE,
    channel_type    TEXT NOT NULL CHECK (channel_type IN ('websocket', 'webhook', 'email')),
    status          TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'retried', 'delivered')),
    attempt_number  INTEGER NOT NULL DEFAULT 1,
    latency_ms      INTEGER,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_delivery_log_alert_event ON alert_delivery_log (alert_event_id);
CREATE INDEX idx_alert_delivery_log_tenant ON alert_delivery_log (tenant_id);
SELECT enable_tenant_isolation('alert_delivery_log');
