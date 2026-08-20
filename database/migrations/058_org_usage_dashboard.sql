-- WO-074: organization-wide usage tracking analytics dashboard.
--
-- ## TimescaleDB gap (see TIMESCALEDB_SCHEMA.md)
--
-- This WO's own implementation_steps literally ask for a new
-- `credit_consumption_events` hypertable plus TimescaleDB continuous
-- aggregates (`daily_credit_consumption`, `hourly_credit_consumption`).
-- TimescaleDB is not available in this environment or on the RDS
-- production target — confirmed the same way TIMESCALEDB_SCHEMA.md
-- (WO-042) already confirmed it (`SELECT * FROM pg_available_extensions
-- WHERE name = 'timescaledb'` returns zero rows here). Per that doc's own
-- established precedent, every "TimescaleDB continuous aggregate" in
-- this codebase is a plain materialized view, manually refreshed.
--
-- Beyond that substitution, this migration does NOT create a brand new
-- `credit_consumption_events` table duplicating an event stream that
-- already exists: `credit_transactions` (migration 052/WO-065) already
-- records every credit-consuming action as an append-only ledger row —
-- `tenant_id`, `agent_id`, `credits_debit`, `occurred_at` — which IS the
-- canonical "credit consumption event" for this platform. A parallel
-- `credit_consumption_events` table would either (a) go unpopulated by
-- any real write path (nothing in this codebase produces it), or (b) be
-- kept in sync with `credit_transactions` by yet another dual-write,
-- both worse than aggregating the ledger that already exists. The two
-- new materialized views below aggregate `credit_transactions` directly,
-- exactly the same substitution `credit_balances` (migration 052) already
-- made for the "real-time balance" aggregate.

-- Daily consumption, per tenant + agent — powers the 30/60/90-day trend
-- chart and the agent breakdown bar chart. `credits_debit` is consumption
-- (a `credit` entry_type is a top-up/allocation, not usage).
CREATE MATERIALIZED VIEW daily_credit_consumption AS
SELECT
    tenant_id,
    agent_id,
    date_trunc('day', occurred_at) AS bucket,
    sum(credits_debit) AS total_credits,
    count(*) FILTER (WHERE credits_debit > 0) AS event_count
FROM credit_transactions
GROUP BY tenant_id, agent_id, date_trunc('day', occurred_at)
WITH NO DATA;

-- agent_id is nullable (a tenant-level adjustment with no specific
-- agent) — same NULL-collapsing GROUP BY reasoning credit_balances'
-- own unique index comment already documents; safe for a plain
-- (tenant_id, agent_id, bucket) unique index.
CREATE UNIQUE INDEX idx_daily_credit_consumption_pk ON daily_credit_consumption (tenant_id, agent_id, bucket);
CREATE INDEX idx_daily_credit_consumption_tenant_bucket ON daily_credit_consumption (tenant_id, bucket);

CREATE VIEW daily_credit_consumption_scoped AS
SELECT * FROM daily_credit_consumption WHERE tenant_id = current_setting('app.current_tenant', true)::uuid;
REVOKE ALL ON daily_credit_consumption FROM PUBLIC;
GRANT SELECT ON daily_credit_consumption_scoped TO ams_app;

-- Hourly consumption — same shape, finer granularity, for the
-- <30-second-freshness real-time push path (the WebSocket pusher reads
-- the current hour's bucket after each refresh, not yesterday's daily
-- rollup).
CREATE MATERIALIZED VIEW hourly_credit_consumption AS
SELECT
    tenant_id,
    agent_id,
    date_trunc('hour', occurred_at) AS bucket,
    sum(credits_debit) AS total_credits,
    count(*) FILTER (WHERE credits_debit > 0) AS event_count
FROM credit_transactions
GROUP BY tenant_id, agent_id, date_trunc('hour', occurred_at)
WITH NO DATA;

CREATE UNIQUE INDEX idx_hourly_credit_consumption_pk ON hourly_credit_consumption (tenant_id, agent_id, bucket);
CREATE INDEX idx_hourly_credit_consumption_tenant_bucket ON hourly_credit_consumption (tenant_id, bucket);

CREATE VIEW hourly_credit_consumption_scoped AS
SELECT * FROM hourly_credit_consumption WHERE tenant_id = current_setting('app.current_tenant', true)::uuid;
REVOKE ALL ON hourly_credit_consumption FROM PUBLIC;
GRANT SELECT ON hourly_credit_consumption_scoped TO ams_app;

-- Refresh policies: no pg_cron/external scheduler wired in this sandbox
-- (same documented gap as credit_balances/agent_health_5s_agg) —
-- OrgUsageDashboardRepository.refreshAggregates() is the method a real
-- deployment's scheduler (matching this WO's own architecture.md
-- "add_continuous_aggregate_policy... schedule_interval => '1 hour'"
-- intent) would call, exposed for direct invocation by
-- OrgUsagePublisherService and synthetic-event integration tests.

-- ---------------------------------------------------------------------
-- RBAC: this WO's AC is explicit and literal — "accessible only to
-- users with Platform Administrator or Team Lead roles." The existing
-- WO-023 permission matrix (migration 024) only grants
-- `credit_management:consumption:view_org` to finance_manager;
-- platform_admin holds NEITHER view_org nor view_team today (it has
-- `credit_management:allocation:manage` only). Rather than inventing an
-- unmatrixed ad-hoc role check (this codebase's established pattern —
-- see audit logs' own view_org/view_team split — is always to gate via
-- the permission matrix, never bypass it), platform_admin is granted
-- view_org here: an org-wide administrator being unable to view org-wide
-- consumption was a gap in the original matrix, not an intentional
-- exclusion (platform_admin already holds analogous view_org-shaped
-- grants everywhere else — audit_access:logs:view_org, etc). team_lead
-- already holds `credit_management:consumption:view_team`; the org
-- dashboard controller below uses RequireAnyPermission([view_org,
-- view_team]) — same "reuse an existing scoped permission for a
-- broader route than its name literally implies" move
-- DashboardController (WO-056) already documents for AGENT_READ. A
-- team_lead hitting this ORG dashboard sees full org-wide data (this
-- WO's own dashboard, not the team-scoped WO-075 dashboard) — a
-- deliberate, AC-mandated scope widening for this one route only.
INSERT INTO role_permissions (role_name, permission_name) VALUES
    ('platform_admin', 'credit_management:consumption:view_org');
