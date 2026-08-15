-- WO-048's monthly deep-sample job needs to verify a RANDOM sample of
-- individual rows (not a contiguous chain range like verify_audit_chain,
-- migration 038) for hash-content integrity. Recomputing this in
-- application code would require exactly reproducing Postgres's own
-- JSONB-to-text serialization (key ordering/whitespace rules that don't
-- necessarily match JSON.stringify()), so this stays server-side and
-- reuses the exact same digest formula the trigger itself uses.
CREATE OR REPLACE FUNCTION verify_audit_event_hash(p_event_id UUID)
RETURNS TABLE (event_id UUID, valid BOOLEAN, expected_hash TEXT, stored_hash TEXT) AS $$
DECLARE
    rec RECORD;
    computed TEXT;
BEGIN
    SELECT id, tenant_id, actor_id, action, resource_type, resource_id, data_classification, details, occurred_at, prev_hash, record_hash
    INTO rec
    FROM audit_events
    WHERE id = p_event_id;

    IF NOT FOUND THEN
        event_id := p_event_id;
        valid := false;
        expected_hash := NULL;
        stored_hash := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    computed := encode(
        digest(
            coalesce(rec.prev_hash, '') || '|' ||
            rec.tenant_id::text || '|' ||
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

    event_id := rec.id;
    valid := (computed = rec.record_hash);
    expected_hash := computed;
    stored_hash := rec.record_hash;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
