# WO-079 — Agent Registry Page with Real-Time Status — Reconciliation

Branch: `feat/wo-079-agent-registry-page` (based on `main` @ 7ac9d16, WO-075). Not committed/pushed/PR'd — implementation + verification only, per the task boundary.

## What was built

### Backend (`backend/src/agents/`)
- **`dto/list-agents-query.dto.ts`**: `framework`/`lifecycleStatus` are now optional arrays (comma-separated string or repeated-key array both accepted) for the AC's multi-select filtering; added `sortBy` (`name|framework|lifecycleStatus|lastSeen`) and `sortOrder` (`asc|desc`).
- **`agents.repository.ts`**: `findAll` now (a) LEFT JOINs `teams` to resolve a team name, not just id, (b) supports multi-value `framework`/`lifecycleStatus` filters via `= ANY($n::text[])`, (c) supports server-side `ORDER BY` via a whitelisted column map (`SORT_COLUMNS`) — never string-interpolating the client-supplied sort field directly, avoiding SQL injection.
- **`agent.mapper.ts`**: `AgentResource` gains `team: {id, name} | null` and `lastSeen`.
- **`agents.controller.ts`**: `GET /api/v1/agents` response reshaped to `{ data, pagination: {page, pageSize, total, totalPages} }` matching the WO's own `api_contracts`, computed at the controller boundary only — `AgentsService`/`AgentsRepository` keep their existing `{agents, total, limit, offset}` shape so `BulkLifecycleService`'s own filter resolution and this codebase's own service-level tests are untouched.
- **`agents.service.ts`**: `findAll` now also records a structured `agent_registry.viewed` audit event (actor, tenantId, resourceType `agent_registry`, filters/sort/limit/offset applied) — AC #11. Awaited (not fire-and-forget like the two closest precedents, `dashboard.health_view_accessed`/`dashboard.team_usage_viewed`) because this endpoint is called far more often, in tighter request/cleanup cycles, than a dashboard page load.
- **`lifecycle.service.ts`**: every lifecycle transition now ALSO publishes a shape-tagged `{ type: "agent_status_update", agentId, status, lastSeen }` message on the *existing* `/ws/health` Redis pub/sub channel (`HealthGateway`), reusing WO-030's pub/sub infrastructure rather than building a new gateway/channel, per the WO's own explicit instruction to reuse `/ws/health`.

### Frontend
- **`types/dashboard.ts`**: `AGENT_LIFECYCLE_STATUSES`, `AgentRegistryEntry/Filters/Sort/Pagination/Result`, `AgentStatusUpdateMessage`.
- **`components/ui/badge.tsx`**: two new variants, `connecting` (amber) and `decommissioned` (red), alongside the 3 already-existing ones (`active`, `paused`, `retired`) reused for the other 3 lifecycle states.
- **`components/agents/`**: `AgentStatusBadge`, `FrameworkBadge` (with generic fallback for unknown frameworks), `AgentRegistryFilterBar` (multi-select checkboxes for framework/status, free-text team-UUID field — same established plain-HTML pattern as `HealthFilterBar`/`UsageFilterPanel`), `AgentRegistryTable` (sortable headers with visual indicators, row/select-all checkboxes, ARIA-live status cells), `AgentRegistryPaginationBar` (10/25/50/100 page sizes, total count), `AgentRegistryBulkToolbar` (selected count + disabled placeholder Pause/Retire buttons — real wiring is WO-081's scope per the WO's own instructions).
- **`hooks/useAgentRegistryQuery.ts`**: fetches `GET /api/v1/agents`, translating UI-level page/pageSize into the endpoint's own limit/offset.
- **`hooks/useAgentHealthSocket.ts`**: reuses `useRealtimeUpdates("health")` (the exact existing `/ws/health` plumbing WO-057/058 built) and filters for the shape-tagged `agent_status_update` messages, merging by agentId into a `Map`.
- **`app/agents/registry/page.tsx`**: composes everything; handles 401 (redirect to `/login`), 403 (inline alert), 500 (retry banner), WS reconnecting/error banners, loading/empty states (with a "register your first agent" CTA only when zero agents AND no filters are applied).
- **Fixtures**: `test/fixtures/agents/agent-registry-fixtures.json` (55 agents, all 4 frameworks × all 5 lifecycle statuses, some with no team), `test/fixtures/websocket/agent-status-update.json`.
- **Tests**: unit tests for both badges (all 5/4 states + unknown-framework fallback), the filter bar, table (sort, selection, empty state, ARIA-live wrapping), pagination, bulk toolbar; `useAgentRegistryQuery` (query-string construction, multi-select params, auth header, error status propagation); `useAgentHealthSocket` unit + a real-WebSocket **integration** test (`useAgentHealthSocket.integration.test.ts`, using the existing `MockWebSocket`/`installMockWebSocket` harness) exercising the actual subscribe → receive → unsubscribe/disconnect lifecycle, not just a mocked hook; the page test covers loading/success/401/403/500/WS-degraded/empty/real-time-merge states plus 4 separate axe-core scans (loaded, empty, error, loading).

## Scope trims / honest gaps (documented, not silently skipped)

1. **`lastSeen` has no dedicated column.** No heartbeat/telemetry-derived "last seen" timestamp exists on `agents` (telemetry lands in `agent_metrics`, keyed by agent_id, with no per-agent "latest" projection). Used the row's own `updated_at` (bumped on every lifecycle transition/update) as the closest real proxy for both display and sort. A real `last_seen_at` fed by the telemetry/heartbeat path is a natural follow-up, out of this WO's own scope (a UI page, not a new telemetry pipeline).
2. **`healthScore`/`qualityScore`** from the WO's `api_contracts` are not populated (not wired to `QualityScoreService`/anomaly-detection tables) — AC #1's own column list for this page is Name/Framework/Status/Team/Last Seen/Actions only; those two fields don't appear there, and joining 2-3 separate subsystems built for other pages into this list endpoint would be unnecessary rework for this WO.
3. **Wire query-param naming**: kept the endpoint's existing, already-tested `lifecycleStatus` param name (not `status`, as the WO's own literal `api_contracts` names it) to avoid a breaking rename of a param `ListAgentsQueryDto` already has real tests against. The frontend hook translates `AgentRegistryFilters.status` -> `?lifecycleStatus=...` at its own boundary; documented in `useAgentRegistryQuery.ts`.
4. **`useAgentHealthSocket`'s known limitation** (inherited from the shared `useRealtimeUpdates`/`useWebSocketBatcher` "latest-of-the-100ms-batch" delivery model, same one `useHealthWebSocket` itself has): if two *different* agents' `agent_status_update` messages land in the same 100ms batch window, only the later one reaches this hook — the other is superseded before ever being observed. Documented in the hook's own comment; fixing it would mean changing the shared batching infrastructure itself, well outside one page's scope.
5. **E2E/Playwright axe-core scan** (`npm run test:e2e` / `a11y:scan`) was not run — Playwright browser binaries aren't installed in this sandbox (`~/.cache/ms-playwright` doesn't exist) and installing them wasn't attempted (network/binary-download out of scope for this pass). Component-level `vitest-axe` scans across loaded/empty/error/loading states were run instead and pass with zero violations — the same scope gap every prior WO's own reconciliation doc in this session has noted for this sandbox.
6. **`/agents/register`** (the "Register New Agent" CTA target) does not exist yet — WO-080's own scope, per the WO's own instructions. The link points at it anyway (same "point the href at the real future route" convention as `navigation.ts`'s own WO-074/075 comments).

## Verification

- **Backend typecheck**: `npm run typecheck` — clean.
- **Backend build**: `npm run build` (`nest build`) — clean.
- **Backend tests**: `node --test --import tsx test/**/*.test.ts` (real Postgres @ `localhost:5432`, real Redis @ `localhost:6379`) — full suite green (no failures; ~780 assertions across ~200 files). `test/agents/*` specifically: 69 tests, all passing, including the new sort/multi-filter/team-join/audit-event/health-channel-publish tests, all against real Postgres where the WO instructions require it.
- **Frontend typecheck**: `npx tsc --noEmit` — clean.
- **Frontend lint**: `npx eslint .` — clean (0 errors; 1 pre-existing warning in `useVirtualizedAgentList.ts`, unrelated to this WO).
- **Frontend build**: `npm run build` — clean; `/agents/registry` appears in the static route list.
- **Frontend tests**: `npx vitest run` — 316/316 passing (61 files). One test in `virtualized-agent-grid.test.tsx` (untouched by this WO) failed on the very first full-suite run and passed on an immediate re-run and in isolation — a pre-existing flake, not caused by this change.
- **Security scans**:
  - `gitleaks detect --source backend --no-git -v`: 7 findings, all in the pre-existing accepted fixture files (`encryption-sample-payloads.json`, `jwt-fixtures.json`, `saml-idp-keypair.ts`) — none new.
  - `gitleaks detect --source frontend/src --no-git -v`: 1 finding, the pre-existing accepted recharts `dataKey="latencyP50Ms"` false positive in `health-history-chart.tsx` — none new.
  - `semgrep --config .semgrep.yml` over every changed directory: 0 findings.
  - `npm audit --omit=dev` in both `backend` and `frontend`: 0 vulnerabilities.

## Reviewer follow-up fix

Coordinating-session review found a real regression before this was shipped: `LifecycleService`'s new `agent_status_update` publish shares the exact same "health" Redis pub/sub channel as `HealthMetricsPublisherService`'s existing fleet-health snapshots (`useRealtimeUpdates` keys its "latest" store slot purely by channel name, not by consumer). The new `useAgentHealthSocket` hook correctly discriminates via its own `type` check, but the **pre-existing** `useHealthWebSocket` hook (used by the WO-057/058 fleet health dashboard) did not — it would occasionally receive a shape-tagged `agent_status_update` message as its own `latest`, breaking every consumer of `latest.agents` (e.g. `applyHealthFilters(liveSnapshot.agents, ...)`) whenever an agent transitioned lifecycle status while someone had `/agents/health` open. Fixed by rewriting `useHealthWebSocket` to filter via the same shape-discrimination approach (`isFleetHealthSnapshot`), maintaining its own locally-filtered `latest` state via the `onUpdate` callback instead of trusting the shared store's raw value. `useHealthWebSocket.test.ts` rewritten accordingly, with a dedicated regression test asserting an `agent_status_update` message never overwrites a real snapshot. Full frontend suite re-run afterward: 318/318 passing.

## Acceptance criteria — status

1. 6-column table (Name/Framework/Status/Team/Last Seen/Actions) — PASS (`AgentRegistryTable`).
2. Server-side sort with visual direction indicators — PASS (`AgentsRepository.findAll` ORDER BY + `AgentRegistryTable`'s chevrons).
3. Multi-select framework/status filters + team filter — PASS (`ListAgentsQueryDto` arrays, `AgentRegistryFilterBar`).
4. Server-side pagination, 10/25/50/100, total count — PASS (`AgentRegistryPaginationBar`).
5. Framework badge (icon+label, generic fallback) + 5-state color-coded status badge — PASS (`FrameworkBadge`, `AgentStatusBadge`).
6. Real-time updates via `/ws/health` within 5s, no reload — PASS (`useAgentHealthSocket`, `lifecycle.service.ts`'s new publish; every transition pushes immediately, well under 5s).
7. ARIA live region announcing status changes — PASS (status cell wrapped in `aria-live="polite"`).
8. Bulk checkboxes + select-all-on-page + selected-count toolbar — PASS.
9. "Register New Agent" CTA above the table — PASS (links to `/agents/register`, WO-080's route).
10. Tenant-scoped JWT enforcement — PASS (unchanged `RequirePermission`/RLS path; `req.tenantId` still drives every query).
11. Structured audit log entry per page load/filter/sort — PASS (`agent_registry.viewed`, real-Postgres-tested).
12. Zero critical/serious axe-core violations — PASS at the component-test layer (4 states); E2E scan gap documented above.
13. Unit tests (filtering, badges x5/x4, pagination boundaries, WS handling) — PASS.
14. Integration tests (WS subscribe/receive/disconnect, API mocked) — PASS (`useAgentHealthSocket.integration.test.ts`, page test).
15. 50+ agent fixtures, all frameworks/statuses — PASS (55 records, verified by its own fixture test).
