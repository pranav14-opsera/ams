-- Row-level security for every tenant-scoped table created so far.
-- Every subsequent migration that creates a new tenant-scoped table
-- enables RLS on it immediately, in the same migration — not deferred to a
-- later "enable RLS" migration the way this one is, which only works
-- retroactively for tables that already exist. (WO-004's own
-- implementation_steps list this as step 6, before steps 8-12 create more
-- tenant-scoped tables — that ordering can't work as literally written
-- since RLS can't be enabled on a table that doesn't exist yet. Applying
-- it per-table at creation time, immediately, is both the fix and the
-- safer default: a tenant-scoped table is never even briefly created
-- without RLS already active.)
--
-- FORCE ROW LEVEL SECURITY matters here as much as ENABLE does: without
-- FORCE, a table's OWNER bypasses RLS entirely by default in PostgreSQL —
-- and the application's own DB role is very likely that owner. Skipping
-- FORCE is the single most common way teams accidentally ship RLS that
-- does nothing for the connections that matter most.

CREATE OR REPLACE FUNCTION enable_tenant_isolation(target_table regclass)
RETURNS void AS $$
BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target_table);
    EXECUTE format(
        'CREATE POLICY tenant_isolation ON %s USING (tenant_id = current_setting(''app.current_tenant'', true)::uuid)',
        target_table
    );
END;
$$ LANGUAGE plpgsql;

SELECT enable_tenant_isolation('users');
SELECT enable_tenant_isolation('teams');
SELECT enable_tenant_isolation('team_members');
SELECT enable_tenant_isolation('agents');
SELECT enable_tenant_isolation('audit_events');
