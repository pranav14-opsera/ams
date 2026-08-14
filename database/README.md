# database (WO-004)

Schema migrations, seed data, and adversarial RLS tests for the platform's
PostgreSQL 16 database. Infrastructure provisioning (the RDS instance
itself) lives in `infrastructure/terraform/database/postgresql/` — see that
module's README for the TimescaleDB architecture deviation and connection
pooling setup.

## Running locally

```bash
cd database
npm install
DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run migrate
psql -U postgres -d postgres -f seeds/test_data.sql
bash tests/test_rls_isolation.sh localhost 5432 postgres
```

## Migration ordering

Numbered `migrations/*.sql`, applied in filename order by `migrate.js`,
tracked in a `schema_migrations` table so re-running only applies new
files. Forward-only — no down-migrations, matching how this platform
actually operates (roll forward, don't roll back a shipped schema change).

Every migration that creates a tenant-scoped table enables row-level
security on it immediately, in the same migration — see
`006_enable_rls.sql`'s header comment for why this deviates from the work
order's own suggested step ordering (which can't work literally, since it
would enable RLS on tables that don't exist yet at that point).

## The append-only guarantee on `audit_events` and `credit_transactions`

`REVOKE UPDATE, DELETE ... FROM PUBLIC` is necessary but **not sufficient**
— it has no effect on a role with its own explicit `GRANT`. The actual
guarantee comes from `008_create_app_role_and_grants.sql`: the application
connects as `ams_app`, which is granted `SELECT, INSERT` on those two
tables and nothing more, ever. If a future migration needs to grant
additional access to `ams_app`, grant only what's specifically needed —
never `GRANT ALL`, which would silently defeat this.

## Testing

`tests/test_rls_isolation.sh` is the adversarial cross-tenant test the
work order requires. It compares, per table, the row count `ams_app` sees
while impersonating Tenant B against Tenant B's *true* row count (fetched
via a superuser connection that bypasses RLS) — not against zero, since
Tenant B has its own legitimate data and a naive "expect zero" test passes
even when nothing is actually being tested (this was an actual bug in this
script's first draft, caught during development).
