-- Append-only audit trail with SHA-256 hash chaining (each row's
-- record_hash covers its own content plus the previous row's hash, so any
-- tampering with row N breaks the hash of every row after it) and monthly
-- range partitioning for the 7-year retention requirement.
--
-- Hash chains are inherently per-sequence: since every tenant's events must
-- interleave in real time but the chain must still let each tenant verify
-- their own history independently, the chain is scoped PER TENANT
-- (prev_hash references the previous row for the *same* tenant_id), not
-- one global chain across all tenants.

CREATE TABLE audit_events (
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
    actor_id          UUID REFERENCES users (id) ON DELETE SET NULL,
    action            TEXT NOT NULL,
    resource_type     TEXT NOT NULL,
    resource_id       UUID,
    data_classification TEXT NOT NULL DEFAULT 'internal'
                        CHECK (data_classification IN ('public', 'internal', 'confidential', 'phi')),
    details           JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    prev_hash         TEXT,
    record_hash       TEXT NOT NULL,

    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX idx_audit_events_tenant_time_action_class
    ON audit_events (tenant_id, occurred_at, action, data_classification);

-- Creates the next 12 months of partitions starting from the given date,
-- idempotently (IF NOT EXISTS). Called once at migration time and then
-- periodically (e.g. a monthly scheduled job) to keep rolling ahead.
CREATE OR REPLACE FUNCTION create_audit_events_partitions(start_date DATE, months_ahead INT DEFAULT 12)
RETURNS void AS $$
DECLARE
    partition_start DATE;
    partition_end DATE;
    partition_name TEXT;
    i INT;
BEGIN
    FOR i IN 0..months_ahead - 1 LOOP
        partition_start := date_trunc('month', start_date) + (i || ' months')::interval;
        partition_end := partition_start + interval '1 month';
        partition_name := 'audit_events_' || to_char(partition_start, 'YYYY_MM');

        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
                partition_name, partition_start, partition_end
            );
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT create_audit_events_partitions(date_trunc('month', now())::date, 12);

-- Hash chain trigger: computes record_hash = sha256(prev_hash || canonical
-- row content) on insert. prev_hash is looked up as the most recent row's
-- record_hash for the SAME tenant (NULL for that tenant's very first
-- event, matching the standard "genesis block" pattern).
CREATE OR REPLACE FUNCTION audit_events_hash_chain()
RETURNS trigger AS $$
DECLARE
    previous_hash TEXT;
BEGIN
    SELECT record_hash INTO previous_hash
    FROM audit_events
    WHERE tenant_id = NEW.tenant_id
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1;

    NEW.prev_hash := previous_hash;
    NEW.record_hash := encode(
        digest(
            coalesce(previous_hash, '') || '|' ||
            NEW.tenant_id::text || '|' ||
            coalesce(NEW.actor_id::text, '') || '|' ||
            NEW.action || '|' ||
            NEW.resource_type || '|' ||
            coalesce(NEW.resource_id::text, '') || '|' ||
            NEW.data_classification || '|' ||
            NEW.details::text || '|' ||
            NEW.occurred_at::text,
            'sha256'
        ),
        'hex'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_events_hash_chain
    BEFORE INSERT ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION audit_events_hash_chain();

-- Append-only: no UPDATE or DELETE, from anyone, ever. Retention/purge (see
-- WO-049) must use partition detach + archive, never row deletion, to keep
-- the hash chain's tamper-evidence property intact for retained partitions.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
