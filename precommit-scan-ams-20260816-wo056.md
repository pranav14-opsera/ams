# Pre-commit security scan — WO-056 (Real-Time Agent Health Overview Dashboard)

**Date:** 2026-08-16
**Branch:** wo-056-health-dashboard

## Scope
Backend: `DashboardService`/`DashboardController` (REST, role-scoped, PHI-scrubbed, Redis-cached fallback), `HealthDashboardRepository` (queries the existing `agent_health_5s_agg_scoped` materialized view from migration 036, no new migration needed), `HealthGateway` (WebSocket, reuses `BaseRealtimeGateway`), `HealthMetricsPublisherService` (in-process Kafka-substitute bridge, same established pattern as WO-041/043/046).
Frontend: `/agents/health` page, `FleetHealthSummary`/`AgentHealthCard`/`HealthFilterBar` components, `useFleetHealthQuery`/`useHealthWebSocket` hooks, new `Card`/`Badge` UI primitives.

## Scans
- `gitleaks detect` (after `rm -rf frontend/.next`): clean.
- Custom `.semgrep.yml` ruleset (raw-sql-missing-tenant-filter): 0 findings — every raw query in `health-dashboard.repository.ts` explicitly filters by `tenant_id`.
- `npm audit` (backend + frontend, production deps): 0 vulnerabilities.

## Security-relevant design notes
- **Server-side role scoping**: `platform_admin` sees the whole tenant; `team_lead`/`agent_operator` are both scoped to the caller's own team memberships (`TeamMembershipRepository`) — no role, however permissive its UI nav entry looks, gets fleet data outside this scope. Verified in `dashboard.service.test.ts`.
- **PHI scrubbing**: only the agent `name` field (the one free-text, operator-chosen risk surface) is passed through `PhiScrubberService.scrubText` before ever leaving `DashboardService` — found via testing that scrubbing the *whole* view model corrupted UUID `id` fields, fixed to scope the scrub precisely.
- **Tenant isolation**: `HealthDashboardRepository`'s raw queries filter by `tenant_id` explicitly (defense in depth alongside RLS); `HealthMetricsPublisherService.publishUpdate` opens its own `app.current_tenant`-scoped transaction (`HealthDashboardRepository.withTenantScope`) since it runs outside any request context and can't inherit `TenantContextMiddleware`'s scoping.
- **Audit logging**: every dashboard access is recorded via `AuditServicePort` (`dashboard.health_view_accessed`) with the applied filters, per this WO's own implementation step 15.

## Result: PASS
