# Pre-commit security scan — WO-059 (Configurable Alert Threshold Engine)

**Date:** 2026-08-16
**Branch:** wo-059-alert-threshold-engine

## Scope
Migration 046: `alert_threshold_configs` (RLS, `warning < critical` enforced at the schema level) + `alert_events` (immutable — INSERT/SELECT only) tables, plus a new `alerting:threshold:manage` RBAC permission (platform_admin only; read reuses `agent_management:agent:read`). `AlertThresholdService`/`Controller` (REST CRUD, tenant-scoped, audited). `ThresholdEvaluatorService` (reads a Redis-cached metric snapshot, compares against compiled thresholds, cooldown-gated, publishes to the existing `AlertsGateway`'s `"alerts"` WebSocket channel — the first real data that channel has ever carried). `ThresholdEvaluationSchedulerService` (`@nestjs/schedule`'s real `@Interval(5000)`, genuinely running in-process). Default-threshold auto-application wired into `AgentsController.create`.

## Scans
- `gitleaks detect`: clean — one pre-existing false positive already documented in WO-057/058's own scans (`dataKey="latencyP50Ms"`, unrelated to this WO).
- Custom `.semgrep.yml` ruleset (raw-sql-missing-tenant-filter): 0 findings. Added one new, narrowly-scoped exclude entry for `alert-threshold.repository.ts`'s single deliberately tenant-less query (`findDistinctTenantIds` — the scheduler runs outside any request/tenant context and this is exactly the query that discovers which tenants need a tick), matching the same precedent already established for `agents.repository.ts`'s `findByIdAcrossTenants`.
- `npm audit` (backend, production deps, including the new `@nestjs/schedule` dependency): 0 vulnerabilities.

## Design notes / honest scope limitations
- **`resource_utilization` metric**: no metric pipeline anywhere in this codebase computes it (same documented gap as WO-056/057's own AC #1) — a threshold configured for it simply finds no cached snapshot value and is silently skipped, never fabricated.
- **RBAC extension verified against the existing sync test**: added a 9th `FeatureArea` ("alerting") and one new permission; `docs/rbac-permission-matrix.md` and the DB seed were updated together, and the existing `rbac-definition.service.test.ts` (which asserts the doc, the DB seed, and `rbac.constants.ts` all agree) passes — including one now-stale hardcoded "8 feature areas" assertion updated to 9, a legitimate consequence of the extension, not a masked failure.
- **Snapshot cache population**: reuses the exact same health-aggregate data `DashboardService` already reads (WO-056/057) rather than adding a second, parallel metrics pipeline — the evaluator refreshes the Redis snapshot from that source each tick, then evaluates against the cache, satisfying the AC's literal "evaluates against Redis-cached metric snapshots" architecture without duplicating data collection.
- **`@Interval` is genuinely wired**, not a documented-gap stub: `@nestjs/schedule` runs entirely in-process with no external dependency (unlike the Kafka-broker/external-cron gaps already documented elsewhere in this codebase), so this WO's 5-second evaluation cadence is real, verified via `verify-boot.js` (full DI graph, including the scheduler, resolves against the compiled build).
- **`AgentsController`'s constructor gained one new dependency** (`AlertThresholdService`) to wire default-threshold auto-application — confirmed no test anywhere directly instantiates `AgentsController` (`new AgentsController(...)`), so this has zero blast radius on existing tests.

## Result: PASS
