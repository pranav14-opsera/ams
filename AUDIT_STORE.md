# Append-Only Audit Log Store with Hash Chaining (WO-045)

## What already existed before this WO

Migration 005 (predating WO-045, created for earlier tenant/RBAC work)
already built the foundational store this WO asks for:

- `audit_events` table, monthly RANGE-partitioned on `occurred_at`, with
  `prev_hash`/`record_hash` columns.
- `audit_events_hash_chain()` — a `BEFORE INSERT` trigger computing
  `record_hash = SHA-256(prev_hash || tenant_id || actor_id || action ||
  resource_type || resource_id || data_classification || details || occurred_at)`
  via `pgcrypto`'s `digest()`, chained **per tenant** (the previous link is
  the most recent row for that same `tenant_id`).
- Append-only enforcement, two layers: `REVOKE UPDATE, DELETE ON
  audit_events FROM PUBLIC` (migration 005) plus `ams_app` — the
  least-privilege role every real application code path connects as
  (migration 008) — never being granted `UPDATE`/`DELETE` in the first
  place.
- RLS with `FORCE ROW LEVEL SECURITY` (migration 006), so even the table
  owner can't bypass tenant isolation.
- `create_audit_events_partitions(start_date, months_ahead DEFAULT 12)` —
  a manual equivalent of pg_partman, already exceeding this WO's literal
  "3 months ahead" ask (creates 12).
- The exact composite index this WO asks for:
  `idx_audit_events_tenant_time_action_class ON audit_events (tenant_id,
  occurred_at, action, data_classification)`.

None of that is re-implemented here. This WO's actual new work is the
three pieces that were genuinely missing.

## What this WO adds (migration 038 + `backend/src/audit/`)

1. **Per-tenant advisory-lock serialization.** The original trigger's
   "find the previous hash" step was a plain `SELECT ... ORDER BY ...
   LIMIT 1` with no locking — two concurrent inserts for the SAME tenant
   could both read the same `previous_hash` before either committed,
   producing two rows that both claim to extend the chain from the same
   prior link. `pg_advisory_xact_lock(hashtext(tenant_id))` inside the
   trigger now fully serializes chain extension per tenant for the rest
   of the current transaction (auto-released at commit/rollback).
2. **`verify_audit_chain(tenant_id, start_time, end_time)`** — an
   independent SQL function that recomputes the exact same digest formula
   the trigger uses and walks a tenant's chain across a time window,
   returning the first broken link (or `valid: true`) if none is found.
   Seeds from the record immediately before the window so a mid-chain
   window still verifies against the real prior link.
3. **`AuditStoreRepository`** (`backend/src/audit/audit-store.repository.ts`)
   — the typed application-layer surface: `insertAuditEvent()` (with
   retry-with-backoff on `40001`/`40P01` Postgres errors — defense in
   depth on top of the advisory lock, not the primary correctness
   mechanism), `getLastHash()`, and `verifyChain()`. Coexists with the
   pre-existing `AuditServicePort`/`PostgresAuditService` (already
   injected by 10+ services as the generic "record an audit event"
   abstraction) rather than replacing it — this is new, additive surface
   for the verification/foundation concerns this WO specifically asks
   for.

## A real constraint found via testing: chain order requires insertion order

The hash chain is keyed by "the row with the latest `occurred_at` at
insert time," not by any later chronological re-sort. This matches how
real audit events work (an action happens and is recorded at
approximately that moment), but it means:

- Fixture/test data that backdates `occurred_at` must still be inserted
  in **monotonically increasing** `occurred_at` order per tenant — an
  earlier version of `seed-audit-events.ts` round-robinned across 3
  months per index (month0, month1, month2, month0, ...), which jumps
  `occurred_at` backward relative to insertion order and breaks the
  chain.
- The fixture's timeline must start **after** any audit event a tenant
  already has — `TenantProvisioningSaga` itself writes a
  `tenant.provisioned` audit row at real insert time before any fixture
  code runs. An earlier fixture version anchored its timeline to a fixed
  day of the current calendar month, which can already be in the past
  relative to "now" — landing that pre-existing row chronologically in
  the middle of the fixture's own synthetic timeline and breaking the
  chain the same way. Fixed by anchoring the fixture strictly after
  `Date.now()`.

## Mock fixtures

`backend/test/fixtures/audit/seed-audit-events.ts` generates real,
hash-chained rows (via `AuditStoreRepository`, not hand-crafted SQL that
would need to replicate the trigger's digest logic) — at least 1,000
events across 3 tenants, spread across 3 consecutive monthly partitions
computed relative to "now" rather than a hardcoded calendar month.
