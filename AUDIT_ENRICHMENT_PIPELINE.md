# Audit Event Enrichment Pipeline with PHI Scrubbing (WO-046)

## Architecture, and why it deviates from a literal reading of the AC

The AC describes a Kafka consumer microservice reading from an
`audit-events` topic. **This sandbox has no reachable Kafka broker** —
confirmed directly (`ECONNREFUSED` on `localhost:9092`, no Docker/
testcontainers available), the same class of environment gap
documented in `TELEMETRY_PIPELINE.md` (WO-034), `STREAM_PROCESSING.md`
(WO-041), and `LOAD_TEST_RESULTS.md` (WO-044). Consistent with those,
this pipeline is built and fully tested against real Postgres, invoked
**in-process** rather than via a standalone consumer group that could
never actually consume anything here. `KafkaAuditEventProducerService`
is a genuine `kafkajs` client (not a stub) — it fails for real against
the unreachable broker, and `AuditEventProducerService`'s buffer/circuit
breaker/eventual DLQ fallback is exercised for real as a result.

## What's new here vs. what WO-045 already built

WO-045 built `audit_events` itself (append-only, hash-chained, RLS) and
`AuditStoreRepository` (`insertAuditEvent`/`getLastHash`/`verifyChain`).
This WO does not touch any of that — it's the layer ABOVE it:

- **`CanonicalAuditEvent`** (`backend/src/audit/events/canonical-audit-event.ts`
  + matching `.schema.json`) — the strict, `additionalProperties:false`
  schema every producing service must conform to, with exactly the field
  set the AC lists (`actor_id`, `actor_type`, `tenant_id`, `action`,
  `resource_type`, `resource_id`, `data_classification`, `ip_address`,
  `change_details`, `correlation_id`, `occurred_at`, plus `event_id` for
  DLQ correlation).
- **`AuditEventProducerService`** — the shared SDK. Wraps
  `KafkaAuditEventProducerService` with per-publish retry (3 attempts,
  exponential backoff), then a CLOSED→OPEN→HALF_OPEN circuit breaker
  (3-failure threshold, 5s reset — same shape as WO-040's
  `KafkaCircuitBreakerProducerService`), then a **count-bounded** (not
  time-bounded) in-memory buffer (default max 10,000, per the AC).
  When the buffer itself is full, `publish()` throws
  `AuditEventBufferFullError` rather than silently evicting or dropping
  — the AC's "never silently dropped" is enforced structurally: the
  caller sees a real failure it must route to the DLQ.
- **`AuditEnrichmentService`** — validates `tenant_id` genuinely exists
  (an unknown tenant never reaches persistence), best-effort resolves
  `actor_id` against `users` when `actor_type` is `user` (every other
  actor type has no `users` row to resolve against, by design), and
  validates/defaults `data_classification` to `restricted` (the
  strictest tier — WO-043's own defense-in-depth precedent) when missing
  or unrecognized.
- **`AuditEventConsumerPipelineService`** — the "Kafka consumer" logic:
  schema validate → enrich → PHI scrub (reuses WO-017/043's
  `PhiScrubberService` exactly as `TelemetryPipelineService` does — no
  duplicate scrubbing logic) → `AuditStoreRepository.insertAuditEvent()`.
  Any failure at any stage routes to `audit_events_dlq` (migration 039,
  modeled on `telemetry_dead_letter_events`) rather than being dropped.

## A structural note: `actor_id`'s FK constraint

`audit_events.actor_id` is `REFERENCES users(id)` — there is no row to
reference for `system`/`service_account`/`api_key` actors. The pipeline
maps `actor_id` to `NULL` at persistence time for any actor type other
than a resolved `user`, while preserving the original `actor_type`
(and, for traceability, `correlation_id`/`ip_address`) inside
`audit_events.details` — the one free-form JSONB field. This is not a
schema change; it's how the pipeline bridges the SDK's richer actor
model onto the storage layer's existing, intentionally user-scoped FK.

## What's genuinely not verifiable in this environment

- **Real Kafka topic creation/partitioning** (partitioned by `tenant_id`,
  replication factor 3) — no broker to create topics against. Documented
  as the intended production configuration, not implemented as
  admin-client code that would have no target to run against.
- **Consumer lag monitoring / P2 alert at >60s** — there is no Kafka
  consumer group anywhere in this codebase (the in-process pipeline
  invocation is the substitute, per `STREAM_PROCESSING.md`'s own
  precedent). A lag monitor requires a consumer group to lag in the
  first place; building a fake one to monitor would be theater.

## Fixtures

`backend/test/fixtures/audit-events/audit-event-fixtures.json` — 52
sample audit events (16 with embedded PHI across all the scrubber's
pattern types: name, SSN, MRN, DOB, ICD-10, email, phone, nested
objects, arrays, and free-text-embedded values), exceeding the AC's
literal "50+ events, 15+ with PHI."
