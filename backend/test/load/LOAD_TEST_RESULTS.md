# WO-044 Load Test Results and Methodology

## Why this deviates from the AC's literal architecture

The AC frames end-to-end latency as five network-separated segments:
agent emit → Kafka publish → stream processing → TimescaleDB write →
WebSocket push → dashboard render, each independently measurable because
a real deployment has a Kafka broker and a separate consumer process
between the first three.

This sandbox has **no reachable Kafka broker** — confirmed directly (a
connection probe to `localhost:9092` returns `ECONNREFUSED`) and no
Docker/testcontainers available to stand one up. This is the same,
repeatedly-documented environment gap as WO-034/040/041's own
reconciliation docs (`TELEMETRY_PIPELINE.md`, `STREAM_PROCESSING.md`).
There is also no frontend client in this repository, so "WebSocket push →
dashboard render" has no code to measure at all.

Rather than fabricate numbers for segments that cannot exist here, this
WO measures every segment that genuinely exists in this codebase today,
and documents the rest as explicitly unverifiable in this environment
(not silently omitted — every load test report's
`notVerifiableInThisEnvironment` field lists them).

## What's actually measured

`TelemetryPipelineService.process()` gained an optional `onStage` hook
(zero behavior change when omitted — every existing caller is
unaffected) that reports wall-clock time for each stage of this
platform's real, synchronous, single-process pipeline:

| Stage | What it measures | AC segment it maps to |
| --- | --- | --- |
| `schema_validation` | JSON Schema validation of the canonical event | — |
| `tenant_enrichment_and_classification` | tenant lookup + WO-016 classification | — |
| `phi_scrub_and_secondary_validation` | WO-017/043 two-pass PHI scrub + secondary validator | — |
| `kafka_publish_attempt` | the real `kafkajs` produce call itself | "agent emit → Kafka publish" (see caveat below) |
| `postgres_metrics_write` | `MetricsAggregatorService.recordCanonicalEvent()` against real Postgres | "stream processing → TimescaleDB write" |
| `websocket_delivery` (measured separately, `ws-load-test-integration.test.ts`) | real Redis pub/sub → `BaseRealtimeGateway` → connected client | "TimescaleDB → WebSocket push" |

**Caveat on `kafka_publish_attempt`**: in this sandbox the produce call
fails fast against an unreachable broker (falls back to the dead-letter
queue) rather than round-tripping to a real one — its measured latency
here is the cost of a fast local connection-refused failure, not
representative of real network-separated Kafka latency. It's still a
genuine, real measurement of the ONE segment of the real pipeline code
this stage boundary corresponds to; it is not a substitute for a real
broker benchmark.

**Not verifiable in this environment at all** (listed in every report,
not silently dropped):
- Kafka publish → consumer receipt (no broker, no consumer group exists in this codebase)
- Consumer lag alerting (same reason — there's no consumer group to lag)
- WebSocket push → dashboard render (no frontend client in this repo)

## A real bug this load test found

The very first run of the synthetic event generator (whose events embed
a `generatedAtMs` timestamp in `metadata` for future end-to-end latency
correlation) immediately broke `TelemetryPipelineService`'s PHI scrubbing
with `"Unexpected token 'M', ... is not valid JSON"`. Root cause:
`scrubText()`'s unanchored substring regex was being run over
`JSON.stringify()` of the ENTIRE metadata object (not per string field),
so it could match — and mask — digits inside an unquoted JSON *number*
(the MRN pattern matches any 6-10 digit run, and a millisecond timestamp
is 13 digits), corrupting the JSON structure itself.

Fixed by adding `PhiScrubberService.scrubEmbeddedText()`, which
recursively walks the structure and applies `scrubText()` only to STRING
leaves, leaving numbers/booleans/null untouched. `TelemetryPipelineService`
and `PhiSecondaryValidator` (which had the identical bug — its
`hasResidualPhi()` check was also stringifying-then-scrubbing the whole
object, which meant it started falsely flagging *every* event carrying a
timestamp field as still containing PHI, quarantining 100% of traffic)
were both updated to use it. See `backend/test/phi-scrubber/phi-scrubber.service.test.ts`
for the regression tests.

## Real results (2026-08-15, this sandbox, 1x profile)

30-second slice at the 1x profile's target rate (12 events/sec), driven
through the real pipeline against real local Postgres (`npm run
test:load-regression` with `LOAD_REGRESSION_DURATION_SECONDS=30`):

```
eventCount: 360, errorCount: 0, deadLetteredCount: 360 (expected — no broker), quarantinedCount: 0

schema_validation:                    P50=0.08ms  P95=0.13ms  P99=0.34ms
tenant_enrichment_and_classification: P50=1.22ms  P95=1.77ms  P99=2.17ms
phi_scrub_and_secondary_validation:   P50=0.09ms  P95=0.14ms  P99=0.18ms
kafka_publish_attempt:                P50=1.77ms  P95=165.5ms P99=355.3ms   (budget 2000ms — PASS)
postgres_metrics_write:               P50=2.73ms  P95=5.62ms  P99=7.51ms   (budget 2000ms — PASS)
```

WebSocket delivery segment (50 messages, staggered publishes,
`ws-load-test-integration.test.ts`, real Redis + real gateway):

```
websocket_delivery: P50=16.0ms P95=17.0ms P99=17.0ms over 7 batch frames (budget 5000ms — PASS)
```

Every measured segment is comfortably within its P99 budget — this
sandbox's local, single-instance, no-network-hop architecture is
naturally far faster than the AC's budgets, which are sized for a real
multi-service, network-separated production deployment.

## 2x and burst profiles, and the AC's literal 1800s/300s durations

`backend/test/load/profiles/*.json` commit the AC's literal
configuration (12/23/120 events/sec, 1800s/1800s/300s durations, 5-10
tenants). Running those FULL durations is a manual/staging exercise
(`runLoadTest(pipeline, pool, profile)` with no `durationSecondsOverride`
runs the profile's own committed duration) — not part of the automated
suite, which uses short slices (`load-test-integration.test.ts`,
`regression-test.ts`) to stay within normal test/CI time budgets. Given
this sandbox's segments scale linearly with event count and show no
sign of saturation at 1x, and the pipeline has no shared mutable state
across events (each `process()` call is independent), the reduced-duration
results here are expected to hold at the full 1800s/2x/burst scale — but
that is not itself directly demonstrated in this sandbox and should be
confirmed against a real staging environment with a real Kafka broker
before being treated as a production guarantee.

## Consumer lag alerting

Not implemented and not tested: there is no Kafka consumer group
anywhere in this codebase (confirmed via `STREAM_PROCESSING.md`'s own
reconciliation — this platform's single-process synchronous pipeline is
the substitute for a standalone consumer). A consumer-lag monitor
requires a consumer group to exist first; building one is out of scope
for a load-test validation WO.
