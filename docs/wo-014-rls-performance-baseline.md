# RLS performance baseline (WO-014)

Measured with `database/tests/rls_performance_baseline.sh` against a local
PostgreSQL 18 instance seeded via `database/tests/fixtures/rls/seed_two_tenants.sql`
(100+ rows per table per tenant). 1000 queries total: 200 per table across
5 of the 11 RLS-enforced tables, one per table shape (a plain table, a
table with a composite index, a partitioned table, a JSONB-conditions
table, and an SLA-tracked table). Each query is `SET app.current_tenant`
+ `SELECT count(*) ... WHERE tenant_id = ...`, run sequentially
(`pgbench -c 1`) via a single ams_app connection so the numbers reflect
per-query latency, not connection-pool contention.

| table | queries | p50 (ms) | p95 (ms) | mean (ms) |
|---|---|---|---|---|
| users | 200 | 0.292 | 0.546 | 0.600 |
| agents | 200 | 0.303 | 0.509 | 0.343 |
| audit_events | 200 | 0.927 | 1.476 | 1.243 |
| abac_policies | 200 | 0.291 | 0.532 | 0.347 |
| dsr_requests | 200 | 0.301 | 0.507 | 0.335 |

Observations:

- Four of the five tables land around p50 ≈ 0.3ms / p95 ≈ 0.5ms, dominated
  by connection/round-trip overhead rather than the RLS policy check
  itself — a single `tenant_id = current_setting(...)::uuid` predicate is
  cheap, and each table's tenant_id-leading composite index (verified by
  `test_rls_policy_definitions.sh`) means the planner uses an index scan
  rather than a sequential scan under the policy.
- `audit_events` is consistently ~3x slower. This table is RANGE
  partitioned by `occurred_at` (migration 005) — a count(*) filtered only
  by `tenant_id` (no time bound) forces the planner to touch every
  monthly partition rather than pruning to one, which is the actual cost
  here, not RLS. Application queries against audit_events should always
  include an `occurred_at` range (as `idx_audit_events_tenant_time_action_class`
  is designed for) rather than a tenant-only filter like this
  microbenchmark deliberately uses for a like-for-like comparison across
  tables.
- These numbers are a local, single-machine baseline for detecting a
  future regression (e.g. someone drops a composite index, or a new
  policy adds a subquery) — not a production SLA. Re-run
  `rls_performance_baseline.sh` against the same fixture after a schema
  or policy change and compare against this table.
