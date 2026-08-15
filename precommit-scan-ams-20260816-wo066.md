# Pre-commit scan — WO-066 (Real-time credit metering engine with Redis)

## Scope
`MeteringEngineService`: sub-500ms allow/deny decisions from a Redis
balance cache, falling through to a synchronous Postgres ledger check
when within 5% of a per-team hard cap, atomic Redis decrement via Lua,
action-to-credit rate mapping (Redis-cached, 5min TTL), a circuit breaker
around every Redis call, and a `credit.consumption` Kafka event per
decision.

## Architectural decisions
- **"Hard cap" and its 5% buffer, defined by this WO itself.** No prior
  WO defines a per-team credit ceiling (WO-070 "Hard Cap Enforcement" is
  explicitly later in this same epic). Added a minimal, foundational
  `team_credit_limits` table (nullable `hard_cap`, defaulting to "no cap
  configured" = always use the fast cache-only path) — enough for THIS
  WO's own near-cap decision logic, with WO-070 expected to build the
  real configuration/management surface on top of the same table.
  **Interpretation of "within 5% of the hard cap":** the width of the
  danger-zone buffer is `hardCap * 0.05` (an absolute credit amount), and
  an operation triggers the ledger fallthrough when its PROJECTED
  post-operation balance would fall at or below that width — i.e., the
  team is close to being fully depleted relative to the size of its own
  cap, not close to the cap's raw numeric value.
- **Costs are rounded to whole integers** (`Math.round(rate * units)`)
  even though `credit_rate_mappings.credits_per_unit` is `NUMERIC(12,4)`
  (fractional rates are meaningful, e.g. 0.5 credits per token) — because
  `credit_transactions` (WO-065) and Redis's `DECRBY` are both
  integer-only. A fractional rate is fine; the final billed amount for
  any single operation is always a whole credit.
- **Peek-then-atomic-decrement, not decrement-then-check.** The engine
  reads the cached balance once to CHOOSE an enforcement path (fast cache
  vs. ledger fallthrough), then performs the actual allow/deny via a
  SEPARATE atomic Lua `checkAndDecrement` call. This is deliberately
  race-safe despite the two-step read: the atomic call re-checks the
  CURRENT value at decrement time, not the earlier peeked value, so even
  if the balance shifted between the peek and the real decrement (another
  concurrent request), the final outcome is always correct — the peek
  only ever affects which enforcement mode gets used, never the
  allow/deny decision itself. Verified against real Redis with 60
  genuinely concurrent `checkAndDecrement` calls against a 500-credit
  balance at 10 credits each: exactly 50 allowed, 10 denied, final
  balance exactly 0, never negative.
- **Circuit breaker mirrors this codebase's own existing convention**
  (`CircuitBreakerRateLimiterService`, gateway module) — closed/open/
  half-open state machine, 3-failure threshold, "never fail open." For
  credit metering specifically, "never fail open" means: when Redis is
  down, the engine ALWAYS falls through to the authoritative Postgres
  ledger (slower, but correct) rather than either assuming unlimited
  credit (a real financial hole) or blocking every operation outright.
- **A genuinely important behavioral discovery, confirmed by the
  end-to-end integration test**: the fast cache path's Redis decrements
  do NOT touch the real ledger at all — by design, per WO-065's own
  "hybrid consistency model where async reconciliation updates the
  ledger within 60 seconds" framing (WO-067, not yet built). The
  integration test initially assumed the ledger would reflect fast-path
  usage immediately and failed until this was understood and the test
  itself corrected — a useful confirmation that the metering engine's
  behavior here is exactly as the wider architecture intends, not a bug.
- **Kafka**: same documented environment gap as every other Kafka
  producer in this codebase (`KafkaAuditEventProducerService`,
  `KafkaTelemetryProducerService`) — no reachable broker in this sandbox.
  `CreditConsumptionKafkaProducerService` is a real KafkaJS producer that
  genuinely attempts to connect/publish; `MeteringEngineService` treats
  publish failures as non-blocking (the AC's own <500ms P95 requirement
  would be meaningless if a decision waited on Kafka).

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph resolves.
- Unit tests: `metering-engine.service.test.ts` (11 — all 5 of the AC's
  own decision paths plus no-rate/zero-cost/no-team-id/circuit-open/
  structured-logging cases), `credit-cache-circuit-breaker.service.test.ts`
  (5 — closed/open/half-open transitions, never-fails-open, failure-
  counter reset), `credit-rate-mapping.service.test.ts` (4, real Redis
  caching) — all passing.
- Real Redis tests (`credit-cache.service.test.ts`, 5): atomic allow/
  deny/cache-miss via the real Lua script, and 50 genuinely concurrent
  decrements against a real Redis instance never over-decrementing past
  zero.
- Real Postgres+Redis integration tests
  (`metering-engine-integration.test.ts`, 2 tests): full end-to-end flow
  — configure a real rate, cache-miss warms from a real ledger balance,
  two real fast-path allows, then a deliberately stale cache value forces
  a genuine near-hard-cap ledger fallthrough whose result matches the
  REAL ledger (not the stale cache); a separate insufficient-real-balance
  fallthrough-deny case confirms no debit is ever recorded on denial.
- Committed fixtures (`credit-rate-mappings.fixture.ts`, deterministic —
  5 action types × 3 tenants for rates, 5 teams × 3 tenants for cached
  balances) exercised by a dedicated integration test seeding all 15+15
  real rows/keys against real Postgres+Redis and reading them back.
- Full regression: `test/credits`, `test/tenants` — 53 passing, 0
  failing.
- Security: gitleaks (1 finding — the same already-documented recharts
  false positive), semgrep (0 findings), `npm audit` (0 vulnerabilities).
