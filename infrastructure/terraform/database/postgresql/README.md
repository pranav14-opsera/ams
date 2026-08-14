# postgresql module (WO-004)

Provisions the managed PostgreSQL 16 instance, RDS Proxy connection pool,
and enhanced monitoring. Application schema (12 entity tables), RLS
policies, the audit hash chain, and seed/test data live in `database/` at
the repo root, not here — this module owns infrastructure, `database/`
owns schema.

## TimescaleDB — architecture deviation, called out explicitly

The work order asks for the TimescaleDB extension. **AWS RDS for
PostgreSQL does not support it** (neither does Aurora PostgreSQL) — this is
a documented AWS platform limitation, not a missing configuration flag.
TimescaleDB requires a self-managed EC2/container PostgreSQL instance or
Timescale Cloud.

Since this platform runs on RDS, `database/migrations/007_agent_metrics_timeseries.sql`
implements the same practical requirements — efficient time-range storage
with partition pruning, and a fast pre-aggregated read path — using:

- Native PostgreSQL declarative `RANGE` partitioning (1-hour chunks) in
  place of TimescaleDB hypertable chunks
- A materialized view, refreshed on a schedule, in place of a TimescaleDB
  continuous aggregate

If genuine TimescaleDB features (compression, incremental continuous
aggregates, hypertable-specific query planning) become a hard requirement,
moving `agent_metrics` to separate self-managed infrastructure is a
platform-level decision — out of scope here.

## Migration step-ordering deviation

The work order's own `implementation_steps` list RLS enablement (step 6) as
happening *before* several tenant-scoped tables are created (steps 8–12) —
that ordering can't work literally, since RLS can't be enabled on a table
that doesn't exist yet. `database/migrations/006_enable_rls.sql` covers the
tables that exist by that point; every later migration enables RLS on its
own new tenant-scoped table immediately, in the same migration, rather than
deferring it — the safer default, since a tenant-scoped table is never even
briefly created without RLS already active.

## Verification performed

- `terraform fmt -check -recursive`: clean · `tflint --recursive`: 0 errors
- `terraform validate`/`terraform test`: blocked locally by the same
  pre-existing AVG TLS-interception issue documented in WO-001/002/003 —
  not a code defect, runs in CI
- **The database schema itself was verified for real**, not just read:
  PostgreSQL 18 installed locally (`scoop install postgresql`), all 14
  migrations applied cleanly to a fresh database via `database/migrate.js`,
  confirmed idempotent (re-run applies zero migrations), seed data loaded,
  and the adversarial cross-tenant isolation test
  (`database/tests/test_rls_isolation.sh`) passed across all 9 relevant
  tenant-scoped tables in both directions (Tenant A can't see Tenant B's
  rows and vice versa), plus a fail-closed check (no tenant context set →
  zero rows visible, not all rows).
- **Two real bugs were caught by this testing and fixed**:
  1. `REVOKE UPDATE, DELETE ... FROM PUBLIC` on `audit_events` looked
     sufficient but isn't — it has no effect on a role with its own
     explicit `GRANT`. The actual append-only guarantee required a
     dedicated least-privilege `ams_app` role (migration 008) that is
     never granted `UPDATE`/`DELETE` on that table in the first place.
     Confirmed: an app role with `GRANT ALL` could update `audit_events`
     despite the `REVOKE FROM PUBLIC`; `ams_app` correctly gets
     `permission denied`.
  2. The adversarial isolation test's first draft was itself wrong — it
     checked "does Tenant B see zero rows", which is incorrect since
     Tenant B has its own legitimate data. Rewritten to compare Tenant B's
     *visible* count against Tenant B's *true* count (fetched via a
     superuser connection that bypasses RLS), which actually detects
     leakage in either direction.
  3. Roles are cluster-wide in PostgreSQL, not per-database — the
     migration runner failed on a second database in the same local
     cluster until `008_create_app_role_and_grants.sql` was made
     idempotent (`CREATE ROLE` guarded by a `pg_roles` existence check).
- `terraform apply` against real AWS (RDS instance, RDS Proxy, enhanced
  monitoring): not run — no AWS credentials in this environment.
