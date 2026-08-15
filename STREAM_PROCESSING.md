# Stream Processors and Canonical Telemetry Schema (WO-041)

## Reconciliation with WO-034/040

WO-041's "Telemetry Normalizer" (a standalone Kafka consumer group that
translates raw framework-specific events into the canonical schema) is
already done — by construction, not by a downstream consumer. WO-034
established that each adapter's `translateTelemetry()` produces a
canonical event **before** it ever reaches Kafka
([TELEMETRY_PIPELINE.md](TELEMETRY_PIPELINE.md)); only canonical events
are ever published. There is no raw, adapter-specific topic for a
separate normalizer to consume from, and no "malformed event already on
Kafka" case to dead-letter after the fact — schema validation happens
synchronously in `TelemetryPipelineService.process()`, before publish,
and a validation failure is a 400 response to the caller, never a
message that reaches the topic in the first place.

This WO's genuinely new, un-duplicated piece is the **Metrics
Aggregator**.

## Metrics Aggregator

`MetricsAggregatorService.recordCanonicalEvent()` is called from
`TelemetryPipelineService.process()` for every successfully validated
event (regardless of Kafka publish outcome — this is about the agent's
observed behavior, not delivery status), writing `latency_ms` and
`error_rate` data points into the pre-existing `agent_metrics` table.

**The P50/P99 rolling-aggregate computation itself already exists** —
migration 007 (predating this WO) built `agent_metrics_5min_agg`, a
materialized view using `percentile_cont` over 5-minute buckets, as this
codebase's documented substitute for a TimescaleDB continuous aggregate
(AWS RDS PostgreSQL doesn't support the TimescaleDB extension). This
WO's job was just to make sure real data actually reaches that table —
which, before this change, nothing did.

### Why inline, not a standalone Kafka consumer group

Same reasoning as WO-040's circuit breaker: this sandbox has no
reachable Kafka broker (confirmed by direct connection probe — see
TELEMETRY_PIPELINE.md). A "Metrics Aggregator consumer group" that can
never actually consume anything here would be untested theater. Calling
`MetricsAggregatorService` directly from the ingestion path is
functionally equivalent for this platform's current single-instance
deployment, and is honestly testable against real Postgres today
(`backend/test/adapters/metrics/metrics-aggregator-integration.test.ts`
proves real rows land in `agent_metrics` and the pre-existing
materialized view correctly rolls them up — P99 ≥ P50 given a real
latency outlier, and a real recorded error shows up in the aggregated
error rate).

If a genuine multi-instance deployment with a live Kafka broker
processing at higher volume later requires decoupling this from the
request path (e.g. to keep `POST /api/v1/adapters/*/telemetry`'s own
latency budget tight), that's the point to introduce a real standalone
consumer — this implementation's `recordCanonicalEvent()` call is
already isolated behind its own service boundary, making that move
straightforward without touching `TelemetryPipelineService` itself
beyond swapping a direct call for a publish.

### Not implemented (out of scope given the above)

- **t-digest approximate percentiles / an LRU dedup cache**: not needed
  — Postgres's own `percentile_cont` computes *exact* percentiles
  against real stored rows (no approximation required when the data
  fits in a real database), and there's no at-least-once Kafka delivery
  duplicating events here to deduplicate.
- **Consumer lag monitoring**: no consumer exists to lag.
- **A separate dead-letter topic for post-normalization failures**: the
  existing `telemetry_dead_letter_events` table (WO-034) already covers
  the one real failure mode this architecture has (Kafka publish
  failure) — every event is already schema-valid by the time it would
  reach a normalizer.
