# Pre-commit security scan — WO-057 (Agent Health Detail Drill-Down View)

**Date:** 2026-08-16
**Branch:** wo-057-health-drilldown

## Scope
Backend: two new materialized-view granularities (migration 044, 1hr/1day, extending WO-042's TimescaleDB-on-RDS substitute), a new `agent_execution_traces` table + `TraceRepository`/`TraceService` (migration 045, read-time PHI masking), `AgentHealthDetailService`/`AgentHealthDetailController` (single-agent history/traces/lifecycle-history endpoints, custom team-scoped access control), `health-history.util.ts`/`quality-score.util.ts` (time-range→granularity mapping, a lightweight quality-score/drift heuristic).
Frontend: `/agents/health/detail` page (query-param based, not a `[agentId]` dynamic segment — see design note below), `TimeRangeSelector`/`HealthHistoryChart` (new `recharts` dependency)/`TraceTimeline`/`LifecycleHistoryList`/`QualityDriftBadge` components, three new REST query hooks.

## Scans
- `gitleaks detect` (after removing gitignored `frontend/.next`, `frontend/out`, `frontend/coverage` build artifacts — all three tripped the same `dataKey="latencyP50Ms"`-shaped false positive baked into compiled/rendered output): clean on the actual tracked source tree.
- Custom `.semgrep.yml` ruleset (raw-sql-missing-tenant-filter): 0 findings — every raw query in the new `trace.repository.ts` explicitly filters by `tenant_id`.
- `npm audit` (backend + frontend, production deps, including the new `recharts` dependency): 0 vulnerabilities.

## Design notes / honest scope limitations
- **Single-agent access scoping**: `@ResourceTeamParam` (rbac.guard.ts) only compares a route param that's already a team ID against caller membership — an agent ID in the URL isn't one, so `AgentHealthDetailService.assertAgentAccessible` resolves the agent's own `team_id` and checks it directly (same team-scoping decision WO-056 already established for list queries, now applied at the single-resource level).
- **PHI masking on traces**: applied at READ time (`TraceService`), not write time — the raw record stays in `agent_execution_traces` for a genuine compliance audit trail, matching this migration's own doc comment. Verified end-to-end against real Postgres.
- **Quality score / drift status**: a deliberately lightweight heuristic (`quality-score.util.ts`), explicitly documented as NOT a real anomaly-detection system — that's WO-061's own future scope, not reinvented here.
- **Alerts section**: honestly rendered as "not yet available" — no alerts data model exists anywhere in this codebase yet (`AlertsGateway` is an empty WebSocket channel shell). Not fabricating alert data to fill the AC's mention of it.
- **Route shape**: `/agents/health/detail?agentId=...` rather than a `[agentId]` dynamic segment — this frontend is a static export (`next.config.js` `output: "export"`), which requires every dynamic segment's params to be known at build time. Agent IDs aren't. Same "existing codebase constraint overrides the WO's exact wording" precedent as WO-056's own route path.
- **Team_lead trace-permission gap (documented, not silently fixed)**: per the RBAC seed matrix (migration 024), `team_lead` holds neither `trace:view_all` nor `trace:view_assigned` — so a team_lead is currently blocked from `GET /:id/traces` by `RbacGuard` itself, before `AgentHealthDetailService`'s own team-scoping ever runs. Fixing this would mean modifying WO-023/024's already-shipped, tested RBAC seed matrix — out of this WO's own scope; flagged here rather than silently expanding another WO's already-shipped surface.

## Result: PASS
