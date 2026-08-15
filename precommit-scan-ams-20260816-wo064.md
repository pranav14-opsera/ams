# Pre-commit scan — WO-064 (Behavioral drift detection against quality baselines)

## Scope
Two-sample Kolmogorov-Smirnov drift detection comparing an agent's last-
24h quality-score distribution against its WO-063 calibration-window
baseline distribution, requiring 3 consecutive hourly drifting windows
before alerting, degradation-only (never flags improvement), feeding into
WO-060's delivery pipeline and subject to WO-062's suppression.

## Architectural decisions
- **The baseline is a real distribution, reconstructed from
  `quality_score_history`, not a single number.** WO-063 only persists a
  single `baseline_score` (the median) per agent — a genuine two-sample KS
  test needs an actual SAMPLE on each side. Solved by re-querying
  `quality_score_history` bounded to `[calibration_started_at,
  established_at]` (a new `getScoreHistoryInRange` repository method) —
  the exact set of ticks that produced the baseline in the first place is
  still sitting in that table, so no new storage or WO-063 schema change
  was needed.
- **Degradation-only filter, computed alongside the KS test, not instead
  of it.** A statistically significant DIFFERENCE (small p-value) is
  necessary but not sufficient — `isDriftingThisWindow = pValue <
  threshold && currentMean < baselineMean`, so a significant IMPROVEMENT
  is explicitly never classified as drift, matching the AC. Verified with
  a dedicated unit test using a clearly-better recent distribution against
  a clearly-worse baseline.
- **Alert exactly once per drift episode, not once per tick past the
  threshold.** The 3-consecutive-window requirement is a crossing event —
  `shouldAlert` is true only when the streak counter reads EXACTLY 3, not
  "at least 3." Without this, an agent that stays degraded for 10 hours
  straight would fire a fresh alert every single hour. A streak resets to
  0 on any non-drifting tick, so a genuinely new episode (drift → recover
  → drift again) still alerts again on its own 3rd consecutive window.
  Verified with a 5-tick unit test asserting exactly one `drift_events`
  row across ticks 3, 4, and 5.
- **`shouldAlert` (evaluation-level) is distinct from "an alert was
  actually delivered."** The evaluation always reports whether THIS tick
  crossed the 3-window threshold, even if the resulting alert was then
  suppressed (snooze) or cooldown-blocked — mirroring how
  `AnomalyDetectorService` separates "an anomaly was detected" from
  "an event was created." Verified with a dedicated suppression test:
  `shouldAlert === true` but zero `alert_events` rows created.
- **`StatisticalEvidence.algorithmUsed` widened to include `"ks_test"`**,
  with `deviationSigma` repurposed to carry the KS statistic D (not a true
  sigma — the closest existing field to summarize "how far apart the two
  distributions are" for the shared `AlertEvent` shape). The FULL
  evidence (p-value, per-component deltas) lives in the dedicated
  `drift_events` table instead of being squeezed into that shared shape —
  same "compact alert summary + rich dedicated audit table" split as
  WO-061/062's own tables.
- **A genuinely new distributed-state primitive**
  (`DriftStateCacheService` + `DriftStateRepository`), mirroring WO-061's
  `EwmaStateCacheService`/`AnomalyBaselineRepository.updateEwmaState` split
  exactly: Redis is the hot per-tick consecutive-window counter, Postgres
  (`drift_detection_state`) is the durable copy restored on a cache miss.
- **`resetBaseline`/`resetCalibration`** (AC: `POST .../drift/reset-
  baseline`) clears `baseline_score`/`established_at` and restamps
  `calibration_started_at` to now on the EXISTING `quality_score_baselines`
  row, starting an entirely fresh 7-day window — added to
  `QualityScoreRepository`/`QualityScoreService` (the table those live in)
  rather than duplicating baseline-lifecycle logic inside the
  drift-detection module.
- **Optional-DI addition to `AgentHealthDetailService`** (a 3rd, alongside
  WO-063's): two optional trailing params (`DriftEventRepository`,
  `DriftStateRepository`) populate a new `realDrift` field, zero blast
  radius to existing call sites — same pattern used twice already this
  session for this exact file.

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph (including the new
  `drift-detection` module, its scheduler, and its cross-module wiring
  into `AlertsModule`/`QualityScoreModule`/`DashboardModule`) resolves.
- Unit tests: `ks-test.test.ts` (algorithm, 9 — identical/clearly-different/
  borderline/symmetric/minimum-sample/empty/non-finite/differently-sized/
  p-in-range cases), `drift-detection.service.test.ts` (11 — no baseline,
  uncalibrated, insufficient data, stable, degrading, degradation-only
  filter, 3-window crossing, no-re-alert-past-crossing, suppression,
  cooldown, affected-components deltas), `drift-detection.scheduler.service.test.ts`
  (5) — all passing.
- Real Postgres+Redis integration test
  (`drift-detection-integration.test.ts`, 1 test): established a real
  baseline from real seeded calibration-window history, confirmed no
  drift signal exists before any recent data, injected 3 real consecutive
  "hours" of genuinely degraded `quality_score_history` rows, confirmed
  the drift status progression (drifting → drifting → significant_drift),
  a real KS statistic/p-value crossing the significance threshold, a real
  persisted `drift_events` row, a real `alert_events` row with
  `detection_method='drift'`/`algorithmUsed='ks_test'`, and real delivery
  through the shared websocket channel — passing on the first run.
- Full regression: `test/drift-detection`, `test/quality-score`,
  `test/algorithms`, `test/alerts`, `test/dashboard`, `test/agents`,
  `test/anomaly-detection` — 240 passing, 0 failing, 11 skipped
  (Redis/DB-gated) — zero regressions from the `StatisticalEvidence` type
  widening, `AlertsModule` export addition, or the three new/updated
  optional-DI constructor params across `ThresholdEvaluatorService` (WO-062,
  unaffected here) and `AgentHealthDetailService`.
- Security: gitleaks (1 finding — the same already-documented recharts
  `dataKey="latencyP50Ms"` false positive from WO-057 through WO-063,
  after clearing `.next`/`out`/`coverage`), semgrep (0 findings),
  `npm audit` (0 vulnerabilities).
