-- WO-049: retention policy configuration + cold storage tiering manifest.
--
-- retention_policies is tenant-scoped (RLS) — each tenant may configure its
-- own retention period per data category, subject to platform-wide min/max
-- bounds enforced in application code (backend/src/audit/retention/
-- retention-policy.service.ts), e.g. audit_logs: 1-10 years.
--
-- cold_storage_manifest is deliberately NOT tenant-scoped (no RLS): it
-- describes a physical audit_events partition (see migration 005's monthly
-- PARTITION BY RANGE (occurred_at) scheme), and a single monthly partition
-- contains EVERY tenant's rows for that period, not one tenant's. Tiering
-- (archiving a partition to cold storage + dropping it from Postgres) and
-- purging (deleting the cold archive once retention has fully elapsed) are
-- necessarily partition-level, all-tenants-at-once operations — you cannot
-- selectively drop one tenant's rows out of a shared partition without a
-- per-row DELETE, which migration 005 forbids to preserve the hash chain's
-- tamper-evidence property. See AUDIT_RETENTION.md for the full
-- reconciliation of "per-tenant configurable retention" vs. "physically
-- shared, time-partitioned storage."
CREATE TABLE retention_policies (
    tenant_id              UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    data_category          TEXT NOT NULL CHECK (data_category IN ('audit_logs', 'execution_traces', 'usage_metrics')),
    retention_days         INT NOT NULL,
    previous_retention_days INT,
    policy_changed_at      TIMESTAMPTZ,
    updated_by             UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, data_category)
);

SELECT enable_tenant_isolation('retention_policies');
SELECT attach_tenant_context_guard('retention_policies');

GRANT SELECT, INSERT, UPDATE ON retention_policies TO ams_app;

-- One row per audit_events partition that has been tiered to cold storage.
-- period_start/period_end mirror the partition's own FOR VALUES FROM/TO
-- range (migration 005). purged_at is set once the archive itself has been
-- deleted (all tenants' retention for that period has elapsed) — the row
-- is kept (not deleted) as the immutable record of "this data existed, was
-- archived, and was later purged," matching audit_events' own
-- never-physically-forget-that-something-happened posture even though the
-- content itself is gone.
CREATE TABLE cold_storage_manifest (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partition_name TEXT NOT NULL UNIQUE,
    data_category  TEXT NOT NULL DEFAULT 'audit_logs' CHECK (data_category IN ('audit_logs', 'execution_traces', 'usage_metrics')),
    period_start   TIMESTAMPTZ NOT NULL,
    period_end     TIMESTAMPTZ NOT NULL,
    storage_key    TEXT NOT NULL,
    checksum       TEXT NOT NULL,
    row_count      BIGINT NOT NULL,
    tiered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    purged_at      TIMESTAMPTZ
);

CREATE INDEX idx_cold_storage_manifest_period ON cold_storage_manifest (period_start, period_end);

GRANT SELECT, INSERT, UPDATE ON cold_storage_manifest TO ams_app;

-- Read-only: which audit_events partitions exist and are entirely older
-- than the given cutoff. Ordinary pg_catalog reads — ams_app already has
-- SELECT on system catalogs by default, no elevated privilege needed here.
CREATE OR REPLACE FUNCTION list_audit_events_partitions_older_than(cutoff TIMESTAMPTZ)
RETURNS TABLE(partition_name TEXT, period_start TIMESTAMPTZ, period_end TIMESTAMPTZ) AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.relname::TEXT,
        to_timestamp(substring(c.relname FROM 'audit_events_(\d{4}_\d{2})'), 'YYYY_MM')::TIMESTAMPTZ AS period_start,
        (to_timestamp(substring(c.relname FROM 'audit_events_(\d{4}_\d{2})'), 'YYYY_MM') + interval '1 month')::TIMESTAMPTZ AS period_end
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_events'
      AND c.relname ~ '^audit_events_\d{4}_\d{2}$'
      AND (to_timestamp(substring(c.relname FROM 'audit_events_(\d{4}_\d{2})'), 'YYYY_MM') + interval '1 month') <= cutoff;
END;
$$ LANGUAGE plpgsql;

-- ams_app (WO-004's least-privilege role) is never granted UPDATE/DELETE
-- on audit_events (migration 005) and is never the table's owner, so it
-- cannot run ALTER TABLE ... DETACH PARTITION / DROP TABLE directly. This
-- SECURITY DEFINER function is a narrow, auditable exception: it runs with
-- the DEFINING role's privileges (the migration-applying superuser, same
-- as every other DDL in this file) regardless of which role calls it, but
-- can ONLY detach-then-drop a single, already name-validated audit_events
-- partition — it grants no ability to touch a live row, unlike granting
-- ams_app ownership or blanket DDL rights would. This is the tiering job's
-- one legitimate "physical deletion" step (AC: "DROP PARTITION for
-- PostgreSQL"), gated on the CALLER (ColdStorageTieringService) having
-- already archived and checksum-verified the partition's full content.
CREATE OR REPLACE FUNCTION detach_and_drop_audit_events_partition(p_partition_name TEXT)
RETURNS void AS $$
BEGIN
    IF p_partition_name !~ '^audit_events_\d{4}_\d{2}$' THEN
        RAISE EXCEPTION 'refusing to drop % — does not match the audit_events partition naming convention', p_partition_name;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'audit_events' AND c.relname = p_partition_name
    ) THEN
        RAISE EXCEPTION '% is not a current partition of audit_events', p_partition_name;
    END IF;

    EXECUTE format('ALTER TABLE audit_events DETACH PARTITION %I', p_partition_name);
    EXECUTE format('DROP TABLE %I', p_partition_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION list_audit_events_partitions_older_than(TIMESTAMPTZ) TO ams_app;
GRANT EXECUTE ON FUNCTION detach_and_drop_audit_events_partition(TEXT) TO ams_app;
