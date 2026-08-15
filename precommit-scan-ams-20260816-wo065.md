# Pre-commit scan — WO-065 (Credit ledger with double-entry accounting)

## Scope
Foundational credit ledger: `credit_transactions` table, RLS, a
`credit_balances` materialized view + tenant-scoped wrapper, and a
`CreditLedgerService`/`CreditLedgerController` (`GET .../balance`,
`GET .../consumption`). First WO of the credit-metering epic — everything
WO-066 through WO-073 build on this.

## A pre-existing conflicting migration, replaced
Migration 011 already created a `credit_transactions` table — its own
comment even says "(WO-065)" — but with a materially different shape:
`entry_type` (debit|credit) + a single NUMERIC `amount` column, no
`actor_id`, no `created_at`. WO-065's own AC is explicit and literal about
the column list (`credits_debit`/`credits_credit` as separate INTEGER
columns, `running_balance`, `action_type`, `description`, `actor_id`), and
every downstream credit-metering WO will depend on those exact names.
Grepped the codebase — nothing referenced the old table. **Replaced it**
(new migration `052_credit_ledger.sql`, `DROP TABLE ... CASCADE` +
recreate) rather than carrying two divergent, dead ledger schemas
forward. Documented in the migration's own comment: this is a "debit/
credit column pair with a running balance" ledger style (one row per
transaction, one side populated) — a valid double-entry convention, but
distinct from classic multi-account double-entry (two linked, opposite-
signed rows) — implemented exactly as the AC's own column list
describes.

## Architectural decisions
- **Atomic running balance via `pg_advisory_xact_lock`.** The
  running_balance is read-then-add-then-insert, which is only atomic
  under real concurrency with serialization. A transaction-scoped
  advisory lock keyed by a hash of `(tenant_id, team_id)` (auto-released
  at COMMIT/ROLLBACK) serializes concurrent writers for the SAME balance
  key while never blocking writers for a DIFFERENT key. No existing
  precedent for this pattern in the codebase — first ledger-style
  read-then-write requiring true atomicity under concurrency. Verified
  against real Postgres with 20 genuinely concurrent `Promise.all`
  transactions: every row's `running_balance` matches the true
  cumulative sum, and no two rows ever land on the same balance value
  (which would indicate the lock failed to serialize).
- **`Pool` vs `PoolClient` duck-typing** (`"release" in client`) used
  consistently across both `recordTransaction` (decides whether to open
  its own transaction) and `withTenantScope` (decides whether to set
  `app.current_tenant`, since a bare `Pool` hands out a fresh,
  unconfigured connection per call and is never "already scoped" the way
  a `PoolClient` the caller explicitly passed in might be) — a real bug
  caught by this WO's own integration test (calling `getBalance(pool,
  ...)` threw the same class of UUID-cast error WO-061/062 already
  found once for a bare-`Pool`-treated-as-scoped assumption).
- **`credit_balances_scoped`'s missing `GRANT SELECT ... TO ams_app`** —
  found by testing genuine RLS enforcement through the `ams_app` role
  (per this codebase's own established RLS-testing convention, not the
  `postgres` superuser other tests default to locally), not by testing
  through the superuser connection the rest of this session's local dev
  loop otherwise uses. Fixed in the same migration.

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph resolves.
- Unit tests: `credit-ledger.service.test.ts` (9 — valid credit/debit,
  zero-amount rejection, negative-amount rejection, non-finite rejection,
  zero-balance-no-history, real-balance-passthrough, history-passthrough,
  refresh-passthrough).
- Real Postgres integration tests
  (`credit-ledger-integration.test.ts`, 3 tests): genuine RLS enforcement
  through the `ams_app` role (cross-tenant balance/history reads return
  empty; own-tenant reads succeed); 20 genuinely concurrent transactions
  never corrupt the running balance; `getBalance`/`getTransactionHistory`
  return real, materialized-view-refreshed data end-to-end.
- Committed fixture (`test/fixtures/credit-transactions.fixture.ts`,
  deterministic — no `Math.random()` — generator, 1200 transactions
  across the AC's own 3-tenant/5-team shape) exercised by a dedicated
  integration test that seeds all 1200 real rows against real Postgres
  and verifies the resulting `credit_balances` materialized-view sum
  matches the fixture's own independently-computed expected net, per
  tenant.
- Full regression: `test/credits`, `test/tenants` — 25 passing, 0
  failing — zero regressions in tenant-provisioning/RLS machinery this
  module reuses.
- Security: gitleaks (1 finding — the same already-documented recharts
  `dataKey="latencyP50Ms"` false positive from WO-057 through WO-064,
  after clearing `.next`/`out`/`coverage`), semgrep (1 finding on first
  run — a real false positive on the advisory-lock query, which touches
  no tenant-scoped table at all; added to `.semgrep.yml`'s exclude list
  with the same justification style as its existing entries; 0 findings
  after), `npm audit` (0 vulnerabilities).
