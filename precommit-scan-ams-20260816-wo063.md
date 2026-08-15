# Pre-commit scan — WO-063 (Agent quality score computation engine)

## Scope
A real, weighted-composite quality score engine (tool-call success 40% /
reasoning accuracy 35% / output consistency 25%, configurable per tenant),
computed every 5 minutes per active agent from a 1-hour execution window,
stored in `quality_score_history`, with a 7-day-calibration baseline
(`quality_score_baselines`) and a config/read API — distinct from the
lightweight `computeQualityScore`/`computeDriftStatus` proxy WO-057 already
built into the agent health drill-down view (left untouched; see
`quality-score.util.ts`'s own doc comment about why that proxy exists and
what it is NOT).

## Architectural decisions
- **Two components are real proxies, not fabricated data, and documented
  as such.** This platform has no LLM-judge/ground-truth semantic-accuracy
  mechanism and no output-similarity/embedding infrastructure — the two
  components the AC calls "reasoning accuracy" and "output consistency"
  can't be computed from anything that actually exists. Implemented as
  genuine, defensible signals from REAL existing data instead of
  inventing a heavier system or faking a number:
  - Reasoning accuracy = trace-level completion rate
    (`completed / (completed + failed)`) from `agent_execution_traces` —
    reaching `'completed'` rather than `'failed'` is the best real signal
    for "the agent's reasoning reached a valid conclusion."
  - Output consistency = `1 - coefficient of variation` of per-step
    `durationMs` across traces in the window, clamped to [0,1] — a stable
    execution-duration profile is the best real signal for "the agent
    behaves the same way run to run" without content-level output
    comparison. Verified with a dedicated integration test seeding
    erratic durations (50ms–8000ms) and confirming a low consistency
    score results.
  - Tool-call success rate is NOT a proxy — it's the real
    `tool_call_success` metric, queried from raw `agent_metrics` (not the
    1hr materialized aggregate) so all 3 components reflect the exact
    same 1-hour window, avoiding the granularity-mismatch class of bug
    this session already found once in WO-061.
- **Missing-component handling in the algorithm itself
  (`src/algorithms/quality-score.ts`)**: a null component (no data this
  window) is excluded and its weight redistributed proportionally across
  the remaining components, rather than either treating it as 0
  (punishing an agent for a component with no data) or nulling the whole
  composite (making a score unavailable for the common case of a quiet
  agent with good telemetry but no execution traces this tick).
- **A genuinely new distributed-lock primitive**
  (`QualityScoreLockService`, a Redis `SET key NX EX` lock with
  token-checked release). This is the first scheduler in this codebase
  whose own writes are NOT naturally idempotent per tick — every other
  WO-059/060/061/062 scheduler either reads or writes with a cooldown/
  upsert that's safe to run twice; this scheduler inserts a brand-new
  `quality_score_history` row every tick, so running two instances
  concurrently without a lock would double-write. Verified against real
  Redis: concurrent acquire is rejected, release only removes a lock the
  releaser still actually holds (so a stale release from an
  already-expired holder can never delete a DIFFERENT instance's live
  lock).
- **Weights stored per-tenant, DB-CHECKed to sum to 100**
  (`quality_score_configs`), with the same check re-asserted in
  `QualityScoreController` before it ever reaches the database, so a
  misconfigured PUT gets a clear 400 rather than a raw constraint-
  violation error.
- **Optional-DI additions, zero blast radius**: `AgentHealthDetailService`
  gained an optional trailing `qualityScoreService?` param populating a
  new `realQualityScore` field (WO-057's existing `qualityScore`/
  `driftStatus` fields untouched); `AgentsController` gained a required
  `qualityScoreService` param to start calibration on registration
  (verified zero direct instantiation sites, same as the two prior
  WO-061/062 additions to this same controller).

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph (including the new
  `quality-score` module and its scheduler) resolves.
- Unit tests: `quality-score.test.ts` (algorithm, 12), `quality-score.service.test.ts`
  (14), `quality-score.scheduler.service.test.ts` (6), `quality-score-lock.service.test.ts`
  (3, real Redis) — all passing.
- Real Postgres(+Redis) integration tests
  (`quality-score-integration.test.ts`, 4 tests): a genuine composite
  score computed from real seeded tool-call telemetry (9/10 success) and
  real execution traces (8 completed/2 failed, tight step durations) with
  component scores landing in the expected ranges; a separate erratic-
  duration case confirming low consistency; real median-based baseline
  establishment across 5 real `quality_score_history` rows; and a full
  scheduler tick against real Postgres+Redis (lock acquired, score
  computed and persisted, lock released) — all passing on the first run.
- Full regression: `test/quality-score`, `test/dashboard`, `test/agents`,
  `test/algorithms` — 162 passing, 0 failing, 11 skipped (Redis/DB-gated)
  — zero regressions from the two optional-DI additions.
- Security: gitleaks (1 finding — the same already-documented recharts
  `dataKey="latencyP50Ms"` false positive from WO-057 through WO-062,
  after clearing `.next`/`out`/`coverage`), semgrep (0 findings),
  `npm audit` (0 vulnerabilities).
