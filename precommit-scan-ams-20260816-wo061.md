# Pre-commit scan — WO-061 (Statistical anomaly/drift detection)

## Scope
EWMA + z-score statistical anomaly detection layered on top of WO-059/060's
threshold-alerting pipeline: `drift_detection_configs`/`anomaly_baselines`
tables, a 7-day calibration lifecycle, a new `anomaly-detection` module
(config repo, baseline repo, `CalibrationService`, Redis-backed EWMA-state
cache, `AnomalyDetectorService`, a dedicated 5s scheduler), a
config/read controller, a "Calibrating" badge on the fleet dashboard, and
calibration auto-start on agent registration.

## Architectural decisions
- **Circular-module avoidance**: the WO's own wording asked to "extend"
  WO-059's `ThresholdEvaluationSchedulerService`, but that scheduler lives
  in `AlertsModule`, and `AnomalyDetectorService` itself depends on
  `AlertsModule` (for `AlertEventRepository`/`AlertDeliveryService`) — having
  `AlertsModule`'s own scheduler also depend on `AnomalyDetectorService`
  would be a genuine cycle. Implemented as a separate
  `AnomalyEvaluationSchedulerService` inside the `anomaly-detection` module
  instead, on the identical 5s cadence — a clean one-directional
  `anomaly-detection → alerts` dependency, no `forwardRef()`.
- **Metric-unit consistency**: `CalibrationService.checkAndCompleteCalibration`
  (baseline) and `.getLatestMetricValue` (live evaluation) both query the
  SAME view/column (`agent_metrics_1hr_agg_scoped`), never WO-059's
  5-second-bucket snapshot cache — a baseline computed from one
  granularity must never be evaluated against a different one.
- **Optional-DI for additive dashboard feature**: `DashboardService` gained
  an OPTIONAL trailing `calibrationService?` constructor param so every
  existing 5-arg test call site keeps compiling/passing unchanged, while
  real Nest-wired instances get the "Calibrating" badge. `AgentsController`
  instead gained a REQUIRED `calibrationService` param — verified via grep
  that nothing directly instantiates `AgentsController`, so this is
  zero-blast-radius.

## Real bug found and fixed during integration testing
`CalibrationService.checkAndCompleteCalibration` and `.getLatestMetricValue`
query the tenant-scoped view `agent_metrics_1hr_agg_scoped`, which embeds
`current_setting('app.current_tenant', true)::uuid` directly in its own
`WHERE` clause — that's a hard-coded predicate baked into the view, not an
RLS policy, so it evaluates (and throws `invalid input syntax for type
uuid` on an empty string) regardless of role/superuser status whenever the
session variable was never set. Request-scoped callers get this for free
from `TenantContextMiddleware`; `AnomalyDetectorService`'s background
scheduler has no request/connection to inherit it from and never set it —
this would have thrown in production on every single evaluation tick, not
just in the test. Caught by the real-Postgres integration test (see below),
not by any unit test (the calibration unit tests use a `FakePool`).

**Fix**: added `CalibrationService.withTenantScope()`, mirroring this
codebase's own established pattern
(`HealthDashboardRepository.withTenantScope`) — when no scoped `client` is
passed in, it acquires a dedicated connection, `set_config`s
`app.current_tenant` on it, runs the query, and releases it. Both
`_scoped`-view query sites now go through this helper. Verified by rerunning
the integration test (previously failing with the UUID cast error, now
passing) and all 20 pre-existing/new calibration + detector unit tests
(the `FakePool` test double gained a `.connect()` method to match).

## Documented honest gaps
- **Statistical-evidence test surface**: unit tests for
  `AnomalyDetectorService` use hand-rolled fakes for every dependency
  (mirroring WO-059's own `threshold-evaluator.service.test.ts` style),
  not a full Nest test module — consistent with this codebase's existing
  convention, not a WO-061-specific shortcut.
- **Real-Postgres integration test seeds one raw sample per metric per
  hour** for the 7-day calibration window (168 hours) rather than dense
  sub-hour sampling — sufficient because the hourly materialized view
  aggregates `avg`/`var_pop` over hourly buckets, not raw samples, so one
  representative value per bucket exercises the exact same code path a
  denser seed would.

## Verification
- `npm run typecheck` — clean.
- `npm run build` — clean.
- `node scripts/verify-boot.js` — full `AppModule` DI graph (including the
  new `anomaly-detection` module and its scheduler) resolves cleanly
  against the compiled build.
- Unit tests: `ewma.test.ts` (10), `zscore.test.ts` (10),
  `calibration.service.test.ts` (10), `anomaly-detector.service.test.ts`
  (10) — all passing.
- Real Postgres+Redis integration tests
  (`anomaly-detector-integration.test.ts`, 2 tests): seeded a real 7-day
  hourly telemetry history for latency/error_rate/token_consumption,
  completed calibration against the real computed mean/variance, injected
  genuine EWMA (error_rate) and z-score (token_consumption) anomalies,
  confirmed both `detection_method='anomaly'` alert events are generated,
  persisted, and delivered through the shared `AlertDeliveryService`
  pipeline (websocket channel logged as `sent`) inside the AC's 60s window;
  confirmed cooldown suppression; confirmed an agent still inside its 7-day
  calibration window never alerts regardless of how extreme its current
  value is.
- Full regression: all tests in `test/anomaly-detection`, `test/alerts`,
  `test/dashboard`, `test/agents` (138 passing, 0 failing, 11 skipped —
  Redis/DB-gated) — zero regressions from the `DashboardService`/
  `AgentsController` constructor changes.
- Full backend suite (`npm test`, both with and without `DATABASE_URL`):
  ran clean serially (`--test-concurrency=1`: 585 passing, 0 failing, 11
  skipped). The default-concurrency parallel run shows pre-existing,
  WO-061-unrelated flakiness — deadlocks (`40P01`) from multiple
  integration test files provisioning tenants concurrently against the
  same local Postgres instance (failures land in SSO/SAML, SCIM, audit
  export, cold-storage-tiering, load-test — none in any module WO-061
  touched). Not introduced by this WO; out of scope to fix the shared
  test-file concurrency model here.
- Security: gitleaks (1 finding — the same already-documented
  `dataKey="latencyP50Ms"` recharts-prop false positive from
  WO-057/058/059/060, after clearing `.next`/`out`/`coverage`), semgrep
  (`.semgrep.yml`, 0 findings), `npm audit` (0 vulnerabilities).
