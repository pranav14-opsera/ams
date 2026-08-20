# WO-075 — Team-Scoped Usage Analytics Dashboard With Filtering: pre-commit reconciliation

## Summary

Implemented the team-scoped usage analytics dashboard reusing WO-074's own
patterns: a `TeamUsageDashboardService`/`TeamUsageDashboardRepository` pair,
a REST endpoint with a rich filter contract, a Redis-pub/sub-backed
WebSocket push channel (reusing WO-074's gateway infrastructure), and a
React frontend page with KPI cards, a filter panel, a team selector, an
agent comparison chart, and a consumption trend chart.

## Honest gaps / deliberate substitutions (documented, not silently skipped)

1. **No new materialized view / no new migration at all.** Unlike WO-074,
   this WO needed no new database migration. `teams`, `team_members`
   (migration 003), `agents.team_id` (migration 004), and
   `credit_transactions.team_id` (migration 052) already exist, and the
   RBAC permission this dashboard needs
   (`credit_management:consumption:view_team` for `team_lead`,
   `credit_management:consumption:view_org` for `platform_admin`) was
   already granted by WO-023/migration 058 — `docs/rbac-permission-matrix.md`
   needed no changes. `TeamUsageDashboardRepository` deliberately queries
   `credit_transactions` directly rather than WO-074's
   `daily_credit_consumption_scoped`/`hourly_credit_consumption_scoped`
   materialized views: those views have no `team_id` column and no
   `action_type`/`framework` dimension, both of which this WO's own filter
   panel AC requires, and re-shaping WO-074's own aggregate views to add
   them was out of this WO's scope. This is a genuinely new query, not a
   duplicated aggregation — the underlying ledger (`credit_transactions`)
   is the same source WO-074's views themselves aggregate.

2. **Team balance reuses WO-068's `CreditBudgetService.getTeamBudget`
   directly**, rather than re-deriving allocated/consumed/remaining/
   utilization independently. A team with no budget row for the current
   month (edge case: never-budgeted team) is caught and surfaced as an
   honest `{allocated: 0, utilizationPct: null}` rather than a 404
   breaking the whole dashboard — the frontend renders this as "Not
   budgeted."

3. **No real per-team WebSocket topic.** The AC's own api_contracts language
   ("team_usage:{team_id}") and this session's own established "no real
   Kafka" substitution both point the same direction: `TeamUsageGateway`
   reuses WO-074's exact `BaseRealtimeGateway`/`RedisPubSubService`
   infrastructure, which partitions pub/sub channels by **tenant**, not by
   team. Every team's update for a tenant is published on the same
   tenant-wide `team_usage` channel, with `teamId` carried in the payload;
   `useTeamUsageSubscription(teamId)` filters client-side to the team
   currently being viewed. This avoids duplicating/forking the WebSocket
   gateway stack for a genuinely team-partitioned topic, at the cost of a
   client every connected client receiving every team's tenant-wide update
   (bandwidth trade-off, not a security/isolation one — the REST endpoint's
   own team authorization is the actual access-control boundary; the socket
   payload carries only balance/burn-rate numbers, no other team's
   agent-level detail).

4. **Team-level isolation is enforced at the application layer, not a
   separate Postgres RLS policy.** This codebase's only existing RLS
   pattern (`enable_tenant_isolation`, migration 006) is tenant-scoped; there
   is no established "team-scoped RLS policy" precedent anywhwere in this
   codebase to follow (WO-068's own team-scoped budget endpoint enforces
   the identical way: `RbacGuard`'s `@ResourceTeamParam` mechanism +
   parameterized `WHERE team_id = $n` queries, not a DB-level policy).
   `team_id` here is a **query parameter**, not a route parameter (per this
   WO's own literal api_contracts: `GET
   /api/v1/dashboards/usage/team?team_id=...`), so `RbacGuard`'s generic
   `@ResourceTeamParam` decorator — which only ever reads `req.params` —
   can't be reused as-is for this route the way it is for
   `CreditBudgetController`'s `/budgets/:teamId`.
   `TeamUsageDashboardService.resolveTeamId` is this route's own equivalent
   check, applied to the query param instead: an org-scoped caller
   (`platform_admin`, or any other role holding
   `view_org`/`view_team`) may target any team, defaulting to the tenant's
   first team when `team_id` is omitted; a team-scoped caller
   (`team_lead`/`agent_operator`) MUST supply a `team_id` they actually
   belong to (checked via `TeamMembershipRepository.getUserTeamIds`) or is
   denied a 403 before any consumption query ever runs. A real-Postgres
   integration test
   (`backend/test/dashboard/team-usage-pipeline.integration.test.ts`)
   proves this end-to-end: two teams under one tenant, Team Lead A gets
   `111` credits (only Team A's), is denied outright for Team B, and
   Platform Administrator sees both teams' real numbers (`111` and `999`
   respectively) — genuine zero cross-team leakage, not just a unit-test
   assertion.

5. **A discovered-and-fixed pre-existing bug in `TeamMembershipRepository`.**
   While building the RLS integration test above, a real bug surfaced:
   `TeamMembershipRepository.getUserTeamIds` queried `team_members` (which
   has RLS enabled, migration 006) via a bare, unscoped `Pool` connection
   with no `app.current_tenant` ever set — meaning a fresh connection
   silently returns zero rows (denying every team-scoped caller
   regardless of real membership), and a connection recycled from an
   earlier tenant-scoped transaction can instead throw `invalid input
   syntax for type uuid: ""` (Postgres reverts a transaction-local
   `set_config(..., true)` to the empty string, not NULL, once that
   custom GUC has been touched at all in the session). This affects
   `RbacGuard`'s own existing `@ResourceTeamParam` check too (used
   in production by WO-068's `/budgets/:teamId`), not just this WO's new
   code. Fixed by adding an optional `client` parameter to
   `getUserTeamIds` (backward compatible — every existing unscoped call
   site keeps working exactly as before) and passing the caller's own
   already-tenant-scoped `client` through from both `RbacGuard` and
   `TeamUsageDashboardService`. This is a small, targeted, in-scope fix to
   a class of bug this WO's own testing directly surfaced — not a
   speculative platform-wide refactor.

6. **Action-type filter options are a hard-coded best-known list on the
   frontend, not server-enumerated.** `credit_transactions.action_type` is
   a free-text column (see `credit_rate_mappings`' own per-tenant-
   configurable rate table) with no fixed platform-wide enum. No backend
   endpoint exists to enumerate a tenant's actual distinct `action_type`
   values, and adding one was out of this WO's scope (the AC only asks for
   an `action_types` multi-select, not a "list distinct action types"
   endpoint). The frontend's `UsageFilterPanel` is given
   `["agent_execution", "tool_call"]` — the only two action types this
   codebase's own real write paths (`MeteringEngineService`/
   `CreditTransactionRepository` call sites) ever actually record — rather
   than a fuller-looking but unbacked list. The backend's own
   `action_types` query param accepts any string values regardless (bound
   as a parameterized `= ANY($n::text[])`, never string-concatenated), so
   a future action type needs no backend change to filter by, only a
   frontend list update.

7. **Framework wire-value translation.** This WO's own api_contracts use
   `frameworks=langchain|crewai|autogen|rest`, but `agents.framework`
   (migration 004) stores `generic_rest`. Translated at the repository
   boundary (`teamUsageFrameworksToDb`/`dbFrameworkToTeamUsageWire`) rather
   than changing the stored column value platform-wide or introducing a
   second inconsistent vocabulary into the rest of the codebase.

## What was built

**Backend** (`backend/src/dashboard/team-usage/`):
- `team-usage-dashboard.types.ts` — period/granularity/framework
  enums+translation, filter/summary/update-message shapes.
- `dto/team-usage-query.dto.ts` — `team_id`/`period`/`granularity`/
  `agents`/`action_types`/`frameworks` query validation (UUID/allowlist
  validated; OWASP A05 — invalid/malicious params rejected 400, never
  reach raw SQL).
- `team-usage-dashboard.repository.ts` — team lookup, tenant/user team
  listing (selector), team agent count, recent-consumption (burn rate),
  filtered per-agent-per-bucket consumption rows, agent roster (for
  zero-consumption agents still appearing in the comparison).
- `team-usage-dashboard.service.ts` — `resolveTeamId` (team
  resolution + cross-team denial), `listSelectableTeams`,
  `getTeamUsageSummary` (KPIs, trend, agent comparison with the 2x-mean
  threshold flag, cache fallback on live-query failure, audit logging of
  team_id + applied filters).
- `team-usage-dashboard.controller.ts` — `GET
  /api/v1/dashboards/usage/team` and `GET
  /api/v1/dashboards/usage/team/teams` (the latter not in the literal
  api_contracts but required to actually populate the team selector).
- `team-usage-cache.service.ts` — Redis last-known-good snapshot cache,
  keyed per tenant+team+filter-combination (a different filter combo is a
  genuinely different result, so it can't share one cache key).
- `team-usage-publisher.service.ts` / `websocket-gateway/gateways/
  team-usage.gateway.ts` — the real-time push leg (see gap #3 above).
- Registered in `dashboard.module.ts` (imports `CreditBudgetModule` for
  gap #2's reuse) and `websocket-gateway.module.ts`.

**Backend tests**:
- `backend/test/dashboard/team-usage-dashboard.service.test.ts` — 18 unit
  tests (team resolution/authorization, selector scoping, balance
  reuse/never-budgeted edge case, zero-agent team, 2x-threshold flagging,
  zero-consumption-agent-still-appears, framework translation, trend
  aggregation, cache fallback, audit logging).
- `backend/test/dashboard/team-usage-pipeline.integration.test.ts` — 2
  real-Postgres/real-Redis integration tests: the genuine zero-cross-team-
  leakage assertion (gap #4/#5 above) plus the full WebSocket push chain,
  and Platform-Administrator-defaults-to-first-team /
  Administrator-in-a-zero-team-tenant edge cases.
- `backend/test/websocket-gateway/team-usage.gateway.test.ts` — 3 real-Redis
  gateway tests (delivery, tenant isolation, multi-team-on-one-channel
  client-filtering per gap #3).
- `backend/test/fixtures/team-usage-mock-data.ts` — 3 teams (one
  zero-agent), 5-6 agents per non-empty team, varied frameworks, one
  engineered 2x-hotspot agent, 30 days of consumption history.

**Frontend**:
- `frontend/src/types/dashboard.ts` — team-usage types appended.
- `frontend/src/hooks/useTeamUsageQuery.ts` /
  `useTeamUsageSubscription.ts`.
- `frontend/src/components/dashboard/team-usage-kpi-cards.tsx`,
  `usage-filter-panel.tsx`, `team-selector.tsx`,
  `agent-comparison-chart.tsx`, `team-consumption-trend-chart.tsx` — each
  with a `.test.tsx` (including axe-core a11y checks).
- `frontend/src/app/dashboard/usage/team/page.tsx` (+ `page.test.tsx`) —
  assembles all of the above, with loading/error/empty states.
- `frontend/src/config/navigation.ts` — the pre-existing `team-dashboard`
  nav entry (seeded by an earlier WO, pointing at a placeholder
  `/analytics/team` route that was never built) repointed at the real
  `/dashboard/usage/team` route.

## Test results (real Postgres + real Redis, not fabricated)

- Backend unit (`team-usage-dashboard.service.test.ts`): **18/18 passed**.
- Backend integration
  (`team-usage-pipeline.integration.test.ts`, real Postgres/Redis): **2/2
  passed** — zero cross-team leakage proven end-to-end.
- Backend gateway (`team-usage.gateway.test.ts`, real Redis): **3/3
  passed**.
- Frontend (`vitest run`, full suite, all 50 test files including the 6 new
  team-usage ones): **244/244 passed**.
- `npm run typecheck` (backend and frontend): clean.
- `npm run build` (backend `nest build`, frontend `next build`): both
  clean; `/dashboard/usage/team` renders in the production build's route
  list.
- `gitleaks detect --source backend --no-git`: 7 findings, all pre-existing
  and previously accepted (`jwt-fixtures.json`, `saml-idp-keypair.ts`,
  `encryption-sample-payloads.json`) — zero new findings from this WO's
  own changes.
- `semgrep --config .semgrep.yml` against every changed directory: **0
  findings**.

## Scope note

This shared checkout (`C:\Users\prana\ams`) is used by other autonomous
agents in this session concurrently. During implementation, several
frontend files (hooks, components, the page, its test, and the navigation
entry) and a couple of backend RBAC files were found already
written/modified on disk mid-task by activity outside this session's own
direct tool calls, converging on essentially the same design this WO's own
backend contract implies. Rather than discard or blindly duplicate that
work, it was reviewed, verified (typecheck/build/full test suite), one real
gap was fixed (the missing `actionTypes` prop wiring on the team dashboard
page, and a stale TypeScript build-info cache masking it), and it is
included in this commit as part of one coherent, verified WO-075
implementation.
