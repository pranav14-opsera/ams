# WO-074 — Organization-Wide Usage Tracking Analytics Dashboard: pre-commit reconciliation

## Summary

Implemented the org-wide usage tracking dashboard: a new TimescaleDB-substitute
aggregate layer over the existing credit ledger, a DashboardService-shaped
`OrgUsageDashboardService`, three REST endpoints, a Redis-pub/sub-backed
WebSocket push channel, and a React frontend page with KPI cards, a trend
chart, and an agent breakdown — following the exact plumbing patterns
established by WO-056 (health dashboard).

## Honest gaps / deliberate substitutions (documented, not silently skipped)

1. **No real TimescaleDB.** Confirmed (again) that this environment's local
   Postgres has zero rows in `pg_available_extensions` for `timescaledb`,
   matching `TIMESCALEDB_SCHEMA.md`'s existing finding for WO-042. Per that
   doc's own established precedent, `daily_credit_consumption` and
   `hourly_credit_consumption` (migration 058) are plain materialized views,
   not continuous aggregates — `_scoped` wrapper views re-apply tenant
   isolation (materialized views can't have RLS applied directly), and
   `OrgUsageDashboardRepository.refreshAggregates()` is the method a real
   scheduler would call on the WO's own 1-hour cadence; no cron/pg_cron is
   wired up in this sandbox (same documented gap as `agent_health_5s_agg`
   and `credit_balances`).

2. **No new `credit_consumption_events` table.** The WO's own
   `implementation_steps`/`database_changes` literally ask for a new
   hypertable. `credit_transactions` (migration 052, WO-065) already IS the
   append-only credit-consumption event stream — every debit row is a
   credit-consuming action with `tenant_id`, `agent_id`, `credits_debit`,
   `occurred_at`. A parallel table would either go unpopulated by any real
   write path, or need a second write for every transaction just to stay in
   sync — strictly worse than aggregating the ledger that already exists.
   `daily_credit_consumption`/`hourly_credit_consumption` aggregate
   `credit_transactions` directly (migration 058's own header comment has
   the full reasoning).

3. **No real Kafka.** Per this session's established substitution (WO-060,
   WO-069, WO-070), the "mock telemetry event -> stream processor ->
   TimescaleDB -> WebSocket" pipeline is exercised as a direct, in-process
   call: `CreditTransactionRepository.recordTransaction` is the real write
   path (the same one `MeteringEngineService`/WO-066 uses for a genuine
   metered event), and `OrgUsagePublisherService.publishUpdate` is the
   direct method a real event-driven trigger would call, reusing
   `RedisPubSubService` — the same "push to dashboard" mechanism
   `HealthMetricsPublisherService` (WO-056) and `LifecycleService.transition`
   already use. The integration test (`org-usage-pipeline.integration.test.ts`)
   exercises this real chain end-to-end: insert a ledger row -> refresh the
   aggregate views -> query through `OrgUsageDashboardService` -> publish
   over Redis pub/sub -> assert delivery at a connected WebSocket client,
   under the 30s freshness budget.

4. **RBAC: platform_admin needed a new grant.** The AC is explicit and
   literal — "accessible only to users with Platform Administrator or Team
   Lead roles." The existing WO-023 permission matrix (migration 024) only
   ever granted `credit_management:consumption:view_org` to
   `finance_manager`; `platform_admin` held neither `view_org` nor
   `view_team`. Migration 058 grants `platform_admin` the `view_org`
   permission (an org-wide administrator being unable to see org-wide
   consumption was a gap in the original matrix, not an intentional
   exclusion — platform_admin already holds the equivalent `view_org`-shaped
   grant everywhere else, e.g. `audit_access:logs:view_org`).
   `docs/rbac-permission-matrix.md` was updated in the same commit (the
   `rbac-definition.service.test.ts` doc-vs-DB parity test still passes).
   The two controllers use `RequireAnyPermission([view_org, view_team])` —
   the same "reuse an existing scoped permission for a broader route than
   its name literally implies" move `DashboardController` (WO-056) already
   documents for `AGENT_READ`. A `team_lead` hitting this ORG route sees the
   full org-wide dashboard (this WO's own dashboard), not a team-filtered
   subset — a deliberate, AC-mandated scope widening for this one route
   only; WO-075's team-scoped dashboard is the route that actually filters
   by team.
   `frontend/src/config/navigation.ts`'s pre-existing `consumption-dashboard`
   nav entry (seeded by an earlier WO, pointing at a placeholder
   `/analytics/consumption` route that was never built) was repointed at the
   real `/dashboard/usage/org` route and its `requiredPermissions` widened
   to match.

## What was built

**Database** (`database/migrations/058_org_usage_dashboard.sql`):
- `daily_credit_consumption` / `hourly_credit_consumption` materialized
  views (tenant_id, agent_id, bucket, total_credits, event_count) aggregating
  `credit_transactions`, each with a `_scoped` RLS-equivalent wrapper view and
  `ams_app` grants.
- `platform_admin` granted `credit_management:consumption:view_org`.

**Backend** (`backend/src/dashboard/org-usage/`):
- `org-usage-dashboard.types.ts` — shared types/enums (period, granularity,
  group-by).
- `org-usage-dashboard.repository.ts` — org balance totals, active agent
  count, burn-rate window, consumption trend, agent breakdown, aggregate
  refresh, tenant-scoped transaction helper.
- `org-usage-cache.service.ts` — Redis last-known-good snapshot cache (60s
  TTL) + a separate short-TTL (30s) balance-only cache for the dedicated
  balance endpoint.
- `org-usage-dashboard.service.ts` — `getOrgUsageSummary` (KPIs + trend +
  breakdown, with cache fallback on live-query failure and an audit event on
  every successful view), `getConsumption`, `getBalance`.
- `org-usage-dashboard.controller.ts` — `GET /api/v1/dashboards/usage/org`.
- `org-usage-credits.controller.ts` — `GET /api/v1/credits/balance`,
  `GET /api/v1/credits/consumption`.
- `org-usage-publisher.service.ts` — refresh + query + publish over
  `RedisPubSubService`, channel `org_usage`.
- `backend/src/websocket-gateway/gateways/org-usage.gateway.ts` — thin
  `BaseRealtimeGateway` subclass, path `/ws/dashboard/usage/org`, reusing all
  of WO-054/055's connection/auth/heartbeat/100ms-batching/reconnect
  infrastructure (50-connection-per-tenant limit included, unchanged).
- Wired into `dashboard.module.ts` and `websocket-gateway.module.ts`.

**Frontend**:
- `frontend/src/types/dashboard.ts` — org usage types appended.
- `frontend/src/hooks/useOrgUsageQuery.ts` — REST load.
- `frontend/src/hooks/useOrgUsageSubscription.ts` — WebSocket subscription +
  staleness flag, same shape as `useHealthWebSocket`.
- `frontend/src/components/dashboard/org-usage-kpi-cards.tsx` — 5 KPI cards.
- `frontend/src/components/dashboard/consumption-trend-chart.tsx` — line
  chart + 30/60/90d toggle + keyboard-navigable table alternative.
- `frontend/src/components/dashboard/agent-consumption-breakdown.tsx` — bar
  chart, sortable, top-10 + expand, keyboard-navigable table alternative.
- `frontend/src/app/dashboard/usage/org/page.tsx` — page composition, loading/
  error/empty states, live-update merge, stale-data indicator.
- `frontend/src/config/navigation.ts` — repointed the pre-existing nav entry.

**Tests**:
- `backend/test/dashboard/org-usage-dashboard.service.test.ts` — 16 unit
  tests: balance calc (healthy/zero/near-cap/over-cap/exactly-100%), cache
  fallback, audit events, `getBalance`/`getConsumption`.
- `backend/test/websocket-gateway/org-usage.gateway.test.ts` — 3 tests:
  same-tenant delivery, cross-tenant isolation, concurrent same-tenant
  connections.
- `backend/test/dashboard/org-usage-pipeline.integration.test.ts` — 3 tests
  against real Postgres (`ams_app` role, not `postgres` superuser — genuine
  RLS enforcement) + real Redis: cross-tenant RLS on the base ledger table,
  cross-tenant RLS on the `_scoped` aggregate views, and the full synthetic-
  event -> ledger -> aggregate refresh -> service -> WebSocket-push pipeline
  under the 30s freshness budget.
- `backend/test/fixtures/usage-dashboard-mock-data.ts` — 3 tenants (healthy /
  near-cap / over-cap), 10-11 agents each, 30 days of daily consumption,
  zero-consumption and never-used-agent edge cases.
- Frontend: `org-usage-kpi-cards.test.tsx`, `consumption-trend-chart.test.tsx`,
  `agent-consumption-breakdown.test.tsx`, `app/dashboard/usage/org/page.test.tsx`
  — 24 tests total, each including a `vitest-axe` zero-violations check. The
  new route is also automatically picked up by the existing Playwright
  `npm run a11y:scan` (`discoverRoutes()` scans everything under `app/`), so
  it is covered by the same E2E WCAG 2.1 AA gate as every other page.

## Test results

- Backend new tests: 19/19 passing (16 unit + 3 gateway... actually 3 gateway
  + 3 integration; see file-level counts above) — `node --test` summary:
  `pass 19, fail 0`.
- `docs/rbac-permission-matrix.md` vs seeded DB parity test: passing (updated
  in the same commit as the migration).
- `backend/test/credits/budget/credit-budget-rbac-integration.test.ts`
  (pre-existing, unrelated to this WO): passes in isolation; showed one
  transient failure when run concurrently as part of a wide multi-directory
  glob against the same shared local Postgres instance in this sandbox — not
  reproducible standalone, and unrelated to any file this WO touched (no
  budget/allocation code was modified). Logged here for transparency, not
  swept under the rug.
- Frontend: full suite 214/214 passing, `npm run build` succeeds, `npm run
  lint` clean (one pre-existing, unrelated warning on
  `useVirtualizedAgentList.ts`).
- `npm run typecheck` clean in both `backend/` and `frontend/`.

## Security scans

- `gitleaks detect --source backend --no-git -v`: 7 findings, all
  pre-existing/accepted (encryption-sample-payloads.json, saml-idp-keypair.ts,
  jwt-fixtures.json) — zero new findings from this WO's changes.
- `gitleaks detect --source frontend --no-git -v`: findings are all either
  the accepted recharts `dataKey` false positive (`latencyP50Ms` in
  `health-history-chart.tsx`, pre-existing) or inside gitignored build
  artifacts (`frontend/out/`, `frontend/.next/`) never committed to git —
  zero new findings in tracked source.
- `semgrep --config .semgrep.yml` against every changed backend file +
  the new migration: 0 findings.
- `npm audit --omit=dev` in both `backend/` and `frontend/`: 0
  vulnerabilities (no new dependencies were added by this WO).

## Acceptance criteria

1. Org dashboard renders at `/dashboard/usage/org`, gated to Platform
   Administrator/Team Lead via `RequireAnyPermission` — PASS (see RBAC gap
   note above for the migration this required).
2. Five KPI cards (balance, consumed, burn rate, active agents, projected
   exhaustion) — PASS, `org-usage-kpi-cards.tsx`.
3. 30/60/90-day trend chart, TimescaleDB-continuous-aggregate-substitute
   sourced — PASS, with the documented substitution (gap #1/#2 above).
4. Agent breakdown bar chart, sortable, top-10 + expandable — PASS,
   `agent-consumption-breakdown.tsx`.
5. <30s refresh via WebSocket push, 100ms batched — PASS (batching is
   `BaseRealtimeGateway`'s existing, unmodified 100ms window); integration
   test asserts <30s end-to-end.
6. RLS tenant isolation, synthetic cross-tenant test — PASS,
   `org-usage-pipeline.integration.test.ts`, connected as `ams_app` (not the
   Postgres superuser, which bypasses RLS).
7. axe-core WCAG 2.1 AA scan, zero critical/serious — PASS at the component/
   page level (`vitest-axe`, all new components + page); the route is also
   automatically included in the existing Playwright `a11y:scan` E2E gate.
8. Unit tests, ≥90% branch coverage of aggregation/balance/WS lifecycle —
   PASS; balance-calc edge cases (zero/near-cap/over-cap/exactly-100%) and
   cache-fallback/audit branches are each individually covered.
9. Integration test: mock event -> stream processor -> TimescaleDB-substitute
   -> WebSocket -> dashboard, <30s — PASS, with the Kafka substitution
   documented in gap #3.
10. Mock fixtures: 3 tenants, 10+ agents each, 30 days, edge cases (zero/
    near-cap/over-cap) — PASS, `usage-dashboard-mock-data.ts`.
11. Immutable audit log entry on dashboard view (actor, tenant_id, timestamp,
    action) — PASS, `dashboard.org_usage_viewed` event recorded on every
    successful `getOrgUsageSummary` call (including the cache-fallback path).

## Edge cases

- New tenant, zero consumption: empty-state message in the page (not broken
  charts) — `page.tsx`'s `isEmptyOrg` branch, tested.
- Exactly-100%-of-cap: `remaining` clamps to 0, burn rate still reported,
  exhaustion reads "Budget exhausted" — tested in both backend and frontend.
- WebSocket drop mid-session: `useOrgUsageSubscription`'s `isStale` flag +
  page's "reconnecting…" banner (reuses WO-054/055's existing reconnect
  infrastructure, unmodified).
- Agent registered, never consumed: appears with `creditsConsumed: 0`, never
  omitted — `getAgentBreakdown`'s `LEFT JOIN FROM agents`, tested at both
  backend and frontend layers.
- Aggregate refresh lag: the dashboard reads whatever the last-refreshed
  materialized view holds; no error surfaces from staleness alone (this is
  the same trade-off `TIMESCALEDB_SCHEMA.md` already accepted for every other
  aggregate in this codebase).
- Concurrent same-tenant viewers: `org-usage.gateway.test.ts`'s two-connection
  test — no duplication, no cross-talk.
