# Pre-commit scan — WO-067 (Async credit reconciliation via Kafka consumer)

## Scope
`CreditReconciliationService.processBatch`: consumes `credit.consumption`
events, deduplicates via `credit_processed_events` (event_id as
idempotency key), records real ledger debits for genuinely unreconciled
consumption, routes per-event failures to a DLQ, refreshes
`credit_balances`, and re-warms the Redis cache — bridging WO-066's fast
Redis path back to WO-065's authoritative ledger.

## Architectural decisions
- **Only "cache"-mode, "allowed", non-zero-cost events represent
  unreconciled consumption.** A "denied" event consumed nothing. A
  "ledger"-mode event's debit was already recorded synchronously at
  metering-decision time (`MeteringEngineService.fallthroughToLedger`,
  WO-066) — reconciling it again here would double-debit the tenant.
  Both are correctly skipped (not failures), verified with dedicated unit
  and integration tests asserting the real ledger only ever gains exactly
  one debit per genuine event in a mixed batch.
- **`eventId` added to `CreditConsumptionEvent`** (WO-066's own type,
  extended here): idempotency needs a stable, caller-assigned key —
  Kafka offsets aren't comparable across a consumer-group rebalance the
  way a UUID generated once at publish time is. `MeteringEngineService`
  now stamps one via `randomUUID()` on every published event.
- **Per-event failure isolation, not whole-batch failure.** Each event in
  a batch is processed independently inside a try/catch; a single
  event's ledger-write failure gets DLQ'd with its error and the rest of
  the batch still proceeds — verified with a mixed good/bad batch.
- **Manual offset commit, real KafkaJS `eachBatch`** (not
  `eachMessage`), matching the AC's explicit "manual offset commit and
  batch size of 100." Per-message `resolveOffset`/`heartbeat` calls
  happen as each message is parsed, but the actual `commitOffsetsIfNecessary`
  only fires after `processBatch` returns — so a crash mid-batch
  redelivers the WHOLE batch on restart, which `credit_processed_events`'
  own idempotency check makes safe to reprocess (verified with a real
  Postgres redelivery test: the exact same 5-event batch processed twice
  produces exactly 5 debits, not 10).
- **Kafka consumer is real but untestable in this sandbox** — same
  documented gap as this codebase's own producers
  (`KafkaAuditEventProducerService`, `KafkaTelemetryProducerService`):
  no reachable broker. `CreditReconciliationConsumerService` genuinely
  connects/subscribes/runs; its `eachBatch` handler is a thin wrapper
  that just calls `CreditReconciliationService.processBatch` — every
  test in this WO exercises that method directly (the same substitution
  pattern used for every Kafka-touching WO this session), not the
  transport layer itself.
- **Health endpoint reports an honestly-null consumer lag.** AC asks for
  "consumer group lag, last successful batch timestamp, and DLQ message
  count." Genuine lag requires a reachable Kafka admin client — absent
  here, so the endpoint returns `consumerGroupLag: null` with an explicit
  `consumerGroupLagUnavailableReason` field, alongside the two metrics
  that ARE genuinely trackable in-process (`lastSuccessfulBatchAt`,
  `dlqMessageCount`). Same global, tenant-less, unauthenticated
  (`@NoPermissionRequired`, added to `PRE_AUTH_ROUTES`) convention as
  `health.controller.ts`'s own routes — a Kafka consumer group's state
  isn't scoped to any one tenant.

## Follow-up (same day): DLQ alert emission
The initial implementation omitted the AC's "an alert is emitted" clause
for DLQ-routed events. Fixed by wiring `CreditReconciliationService`
into WO-060's existing `AlertDeliveryService` pipeline (optional DI, zero
blast radius to existing call sites/tests). `alert_events.agent_id` is a
`NOT NULL` FK (migration 046) — every alert in this codebase is
agent-scoped — so a DLQ'd event with no `agent_id` at all (a team-level
consumption event, not attributed to any single agent) correctly skips
alert emission with a logged warning rather than fabricating a fake
agent reference. 3 new unit tests cover: real emission with a valid
agent_id, the no-agent-id skip, and zero-blast-radius when the alert
services aren't wired at all. Full regression re-run: 69 passing, 0
failing; security scans re-run clean.

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph (including the new
  reconciliation module, its scheduler, and the real-but-unreachable
  Kafka consumer, which connects/retries/stops cleanly during shutdown
  without blocking bootstrap) resolves.
- Unit tests: `credit-reconciliation.service.test.ts` (10 — genuine
  processing, dedup, denied/ledger-mode/zero-cost skip cases, DLQ
  routing with batch-continuation, refresh+re-warm gating, per-key
  re-warm dedup, `lastSuccessfulBatchAt` tracking).
- Real Postgres+Redis integration tests
  (`credit-reconciliation-integration.test.ts`, 2 tests): a batch of 5
  real consumption events reconciled into the real ledger (balance
  correctly reflects `1000 - 5×10`), the real Redis cache re-warmed to
  match, and — critically — redelivering the EXACT SAME batch a second
  time is a genuine no-op (still exactly 5 real debits, not 10); a mixed
  batch (denied + ledger-mode + one genuine event) produces exactly one
  real reconciliation debit. Both complete well under the AC's 60s
  window.
- `credit-processed-events-cleanup.scheduler.service.test.ts` (1, real
  Postgres): purges a real 10-day-old row, leaves a real 1-day-old row
  untouched.
- Full regression: `test/credits` (including `reconciliation/`),
  `test/tenants` — 66 passing, 0 failing.
- Security: gitleaks (1 finding — the same already-documented recharts
  false positive), semgrep (0 findings), `npm audit` (0 vulnerabilities).
