# Pre-commit scan — WO-062 (False-positive alert suppression with feedback)

## Scope
One-click confirm/false-positive feedback on alert events, per-pattern
snoozes (1h/4h/24h/7d), an hourly auto-tune pass that widens a pattern's
warning threshold after sustained false-positive feedback, and a
suppression-metrics API — layered onto WO-059's `ThresholdEvaluatorService`
and WO-060's `AlertDeliveryService`.

## Architectural decisions
- **Auto-tune never touches the critical threshold.** The AC requires
  critical alerts to "never be auto-suppressed." Rather than widening both
  thresholds uniformly (which would risk suppressing genuine critical
  incidents too), the multiplier from `alert_auto_tune_state` is applied
  ONLY to `warningThreshold` in `ThresholdEvaluatorService.classifySeverity`
  — `criticalThreshold` is always evaluated as originally configured. A
  manual snooze, by contrast, suppresses ANY severity including critical —
  that's an explicit user action, not automatic feedback-driven tuning,
  which is exactly what the AC distinguishes ("but can be manually
  snoozed").
- **Auto-tune state kept separate from `alert_threshold_configs`.** A new
  `alert_auto_tune_state` table stores a multiplier (default 1.0, capped at
  2.0) rather than mutating the operator's own configured
  `warningThreshold` in place — this keeps "capped at 2x ORIGINAL" (the
  AC's own wording) meaningful, and means an operator editing their
  threshold later is never silently fighting a prior auto-tune adjustment
  baked into the same column.
- **Re-tuning safety via a feedback cursor.** The naive reading of "3+
  false positives, 0 confirmed in the last 7 days" would re-trigger on
  every hourly scheduler tick for as long as that old feedback remains
  within the rolling 7-day window — causing the multiplier to hit its 2x
  cap within a handful of hours instead of requiring genuinely new
  evidence. `alert_auto_tune_state.feedback_cursor` records the timestamp
  of the pattern's own last tuning pass; the scheduler only counts
  feedback newer than that cursor (or the full 7-day window if never
  tuned) toward the next tuning decision.
- **Optional-DI on `ThresholdEvaluatorService`.** Gained a 6th, OPTIONAL
  `suppressionService?` constructor param — every existing 5-arg unit test
  call site keeps passing unchanged (behaves exactly as before: no
  suppression, no auto-tuning), while the real Nest-wired instance gets
  both. Verified with a dedicated unit test asserting the no-suppression-
  service code path still generates the alert.

## Real bugs found and fixed during integration testing
1. **Non-UUID actor id.** `created_by` on `false_positive_feedback` and
   `alert_snooze_configs` is a UUID column; the integration test initially
   passed a placeholder string (`"admin-user"`) and Postgres correctly
   rejected it (`invalid input syntax for type uuid`). Not a code bug —
   caught the test's own invalid fixture data before it could mask a real
   assertion.
2. **`LEAST($4, $5)` parameter-type ambiguity.** `AlertAutoTuneStateRepository.applyTuningStep`'s
   upsert used untyped placeholders inside `LEAST(...)` for the
   multiplier's step/cap arithmetic; Postgres's parser inferred `text` for
   the unbound parameters (since `LEAST` alone gives it nothing to bind
   against) and rejected the assignment into `warning_multiplier
   DOUBLE PRECISION` ("column ... is of type double precision but
   expression is of type text"). Only surfaced against a real Postgres
   parser — a `FakePool` unit test has no type system to catch this.
   **Fixed** by explicit `::double precision` casts on both parameters in
   both the INSERT and the `ON CONFLICT DO UPDATE` branches.

## Documented interpretation
- The AC's own wording ("increases the suppression threshold... by one
  sensitivity level") and the implementation steps' concrete definition
  ("+20%, capped at 2x original") describe the same directional intent
  (make the pattern harder to trigger a warning for) with different
  vocabulary — implemented against the concrete, testable implementation-
  steps definition, consistent with this WO's own step-by-step spec.
- Fixtures ("committed mock data... for testing suppression logic"): same
  pattern established in WO-061 — realized as the real-Postgres
  integration test's own seed generation (real feedback records, a real
  snooze, real alert event sequences created through the actual
  services/repositories) rather than a separate static fixture file, since
  a generated, parameterized seed exercises the exact same write paths a
  static fixture would otherwise sit beside untested.

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph resolves.
- Unit tests: `alert-feedback.service.test.ts` (3), `alert-suppression.service.test.ts`
  (8, real Redis), `auto-tune.scheduler.service.test.ts` (7), plus 6 new
  suppression-aware cases added to `threshold-evaluator.service.test.ts`
  (no-suppression-wired backward compatibility, snooze suppressing
  warning AND critical, auto-tune multiplier affecting only warning,
  tuned threshold value recorded on the event) — all passing.
- Real Postgres+Redis integration tests
  (`alert-suppression-integration.test.ts`, 2 tests): submitted 3 real
  false-positive feedbacks against 3 real alert events, ran the real
  `AutoTuneSchedulerService`, confirmed the warning multiplier reached 1.2,
  confirmed a value that only breached the pre-tuning warning threshold no
  longer alerts while a genuine critical breach still fires and delivers;
  confirmed a manual snooze suppresses a critical breach until it expires.
  Found and fixed the two real bugs above.
- Full regression: `test/alerts`, `test/dashboard`, `test/agents`,
  `test/anomaly-detection` — 155 passing, 0 failing, 11 skipped
  (Redis/DB-gated) — zero regressions from `ThresholdEvaluatorService`'s
  new optional constructor param.
- Security: gitleaks (1 finding — the same already-documented recharts
  `dataKey="latencyP50Ms"` false positive from WO-057 through WO-061,
  after clearing `.next`/`out`/`coverage`), semgrep (0 findings),
  `npm audit` (0 vulnerabilities).
