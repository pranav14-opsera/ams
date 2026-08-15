-- WO-045: closes two genuine gaps left by migration 005's original
-- append-only hash-chained audit_events (already covers the table
-- itself, per-tenant SHA-256 chaining, RLS with FORCE, REVOKE UPDATE/
-- DELETE, monthly partitioning, and the (tenant_id, occurred_at, action,
-- data_classification) composite index — see AUDIT_STORE.md for the
-- full reconciliation of what already existed vs. what this migration
-- adds).

-- 1. Per-tenant serialization of hash-chain extension. migration 005's
-- trigger looks up "the previous row's record_hash for this tenant" via
-- a plain SELECT ... ORDER BY ... LIMIT 1 with no locking — two
-- concurrent INSERTs for the SAME tenant could both read the same
-- previous_hash before either commits, producing two rows that both
-- claim to extend the chain from the same prior link (a real, if
-- narrow, race). pg_advisory_xact_lock keyed on the tenant_id fully
-- serializes chain extension for that tenant for the rest of the
-- current transaction, auto-released at COMMIT/ROLLBACK — no separate
-- unlock call needed, and no risk of a stuck lock from a crashed
-- session.
CREATE OR REPLACE FUNCTION audit_events_hash_chain()
RETURNS trigger AS $$
DECLARE
    previous_hash TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

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

-- 2. Hash chain verification: walks a tenant's chain across the given
-- time window (seeding from the record immediately BEFORE the window,
-- so a window starting mid-chain still verifies against the real prior
-- link rather than wrongly assuming a genesis start) and returns the
-- FIRST broken link, if any. Recomputes the exact same digest formula
-- the trigger itself uses, so this is a genuine independent
-- verification, not just re-reading the stored hash.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_tenant_id UUID, p_start_time TIMESTAMPTZ, p_end_time TIMESTAMPTZ)
RETURNS TABLE (valid BOOLEAN, first_broken_id UUID, first_broken_occurred_at TIMESTAMPTZ, detail TEXT) AS $$
DECLARE
    rec RECORD;
    expected_hash TEXT;
    running_prev_hash TEXT;
BEGIN
    SELECT record_hash INTO running_prev_hash
    FROM audit_events
    WHERE tenant_id = p_tenant_id AND occurred_at < p_start_time
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1;

    FOR rec IN
        SELECT id, actor_id, action, resource_type, resource_id, data_classification, details, occurred_at, prev_hash, record_hash
        FROM audit_events
        WHERE tenant_id = p_tenant_id AND occurred_at >= p_start_time AND occurred_at <= p_end_time
        ORDER BY occurred_at ASC, id ASC
    LOOP
        IF rec.prev_hash IS DISTINCT FROM running_prev_hash THEN
            valid := false;
            first_broken_id := rec.id;
            first_broken_occurred_at := rec.occurred_at;
            detail := 'stored prev_hash does not match the actual previous record''s hash for this tenant';
            RETURN NEXT;
            RETURN;
        END IF;

        expected_hash := encode(
            digest(
                coalesce(running_prev_hash, '') || '|' ||
                p_tenant_id::text || '|' ||
                coalesce(rec.actor_id::text, '') || '|' ||
                rec.action || '|' ||
                rec.resource_type || '|' ||
                coalesce(rec.resource_id::text, '') || '|' ||
                rec.data_classification || '|' ||
                rec.details::text || '|' ||
                rec.occurred_at::text,
                'sha256'
            ),
            'hex'
        );

        IF expected_hash != rec.record_hash THEN
            valid := false;
            first_broken_id := rec.id;
            first_broken_occurred_at := rec.occurred_at;
            detail := 'record_hash does not match the recomputed hash of this row''s own content — content or hash was tampered with';
            RETURN NEXT;
            RETURN;
        END IF;

        running_prev_hash := rec.record_hash;
    END LOOP;

    valid := true;
    first_broken_id := NULL;
    first_broken_occurred_at := NULL;
    detail := 'chain intact for the given tenant and time range';
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
