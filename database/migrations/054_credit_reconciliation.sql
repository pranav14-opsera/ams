-- WO-067: async reconciliation between the Redis-fast-path metering
-- engine (WO-066) and the authoritative Postgres ledger (WO-065).
-- credit_processed_events is the idempotency ledger for the
-- reconciliation consumer — one row per already-reconciled
-- credit.consumption event, keyed by that event's own event_id.

CREATE TABLE credit_processed_events (
    event_id     UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AC: "7-day TTL" — no pg_cron in this sandbox (same platform constraint
-- as every other scheduled-cleanup WO in this codebase); a scheduled
-- application-level job purges rows older than 7 days, this index makes
-- that purge query (and any lag/backlog inspection) efficient.
CREATE INDEX idx_credit_processed_events_processed_at ON credit_processed_events (processed_at);
CREATE INDEX idx_credit_processed_events_tenant ON credit_processed_events (tenant_id);

SELECT enable_tenant_isolation('credit_processed_events');
GRANT SELECT, INSERT, DELETE ON credit_processed_events TO ams_app;
