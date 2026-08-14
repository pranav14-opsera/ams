-- Dedicated, least-privilege application role. This is what actually makes
-- audit_events append-only in practice: `REVOKE UPDATE, DELETE ... FROM
-- PUBLIC` (migration 005) only removes the implicit grant to PUBLIC — it
-- has no effect on a role that receives its own explicit GRANT. If the
-- application connects as a role with "GRANT ALL" (or is later granted
-- UPDATE/DELETE for some unrelated reason), the append-only guarantee is
-- silently defeated regardless of the PUBLIC-level revoke. Verified this
-- the hard way in this migration's own test: an app_role with `GRANT ALL
-- ON ALL TABLES` could UPDATE audit_events despite the REVOKE FROM PUBLIC
-- in 005. The fix is at the role-provisioning layer, not the table layer:
-- ams_app must only ever receive the specific privileges below, and never
-- a blanket ALL/ALL PRIVILEGES grant.

-- Roles are cluster-wide in PostgreSQL, not per-database — plain
-- `CREATE ROLE` collides if this migration set has already run against
-- another database on the same cluster (e.g. re-running in a dev/CI
-- environment that reuses one Postgres instance across test databases).
-- PostgreSQL has no `CREATE ROLE IF NOT EXISTS`, so guard it explicitly.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ams_app') THEN
        CREATE ROLE ams_app LOGIN;
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    tenants, users, teams, team_members, agents
TO ams_app;

-- audit_events and agent_metrics: append-only. SELECT + INSERT only, ever.
GRANT SELECT, INSERT ON audit_events, agent_metrics TO ams_app;
GRANT SELECT ON agent_metrics_5min_agg_scoped TO ams_app;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ams_app;

-- Every subsequent migration that creates a new tenant-scoped table must
-- add its own GRANT to ams_app here (or in its own migration) — being
-- explicit about which of SELECT/INSERT/UPDATE/DELETE each table actually
-- needs, never GRANT ALL.
