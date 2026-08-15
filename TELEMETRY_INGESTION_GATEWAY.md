# Telemetry Ingestion Adapter Gateway (WO-040)

## This WO substantially overlaps WO-034/035/036 — consolidated, not duplicated

WO-040 (event-streaming epic) and WO-034/035/036 (agent-registry epic)
describe the same ingestion infrastructure: HMAC-authenticated adapter
endpoints, JSON Schema validation, tenant-context enrichment, and
Kafka publication, with a port/adapter pattern isolating framework
volatility. WO-034 already built all of this
([TELEMETRY_PIPELINE.md](TELEMETRY_PIPELINE.md)), and WO-035/WO-036
already shipped the LangChain and generic-REST adapters this WO's Phase
1 calls for ([LANGCHAIN_ADAPTER.md](LANGCHAIN_ADAPTER.md),
[REST_ADAPTER.md](REST_ADAPTER.md)).

Rather than build a second, parallel `TelemetryIngestionController` at
unprefixed routes (`POST /adapters/langchain/telemetry` per this WO's
own AC) alongside the existing `POST /api/v1/adapters/langchain/telemetry`
— which would fragment authentication (two different HMAC middlewares),
double the schema-validation surface, and risk two Kafka producers
racing each other — this WO's real, incremental work is:

1. **Genuinely new**: a circuit breaker around Kafka publication
   (`KafkaCircuitBreakerProducerService`) and HMAC replay protection
   (`X-Timestamp`), neither of which WO-034 built.
2. **Deliberately NOT duplicated**: the route prefix (`/api/v1/...`,
   consistent with every other endpoint in this API — an unprefixed
   `/adapters/...` route would be the one inconsistent surface in the
   entire codebase), the HMAC header name (`X-Signature-256`, not
   `X-Signature`), the controller, the JSON schemas, and the LangChain/
   REST adapters themselves.

## Circuit breaker (`KafkaCircuitBreakerProducerService`)

Wraps `KafkaTelemetryProducerService` — the `TELEMETRY_PUBLISHER` every
caller (`TelemetryPipelineService`) actually injects is this circuit
breaker, not the bare producer. Same CLOSED → OPEN → HALF_OPEN state
machine shape as WO-027's `CircuitBreakerRateLimiterService`, with this
WO's own thresholds: 3 consecutive failures opens the circuit; a 5-second
reset window before the next publish attempt probes Kafka once
(half-open); a successful probe closes the circuit and flushes an
in-memory buffer (events accumulated while open, up to 5 minutes old —
anything older is dropped with a warning, not silently).

This buffer is a **fast-recovery path**, not the durable record — every
`publish()` failure still propagates to `TelemetryPipelineService`, which
still writes to the Postgres dead-letter table (`telemetry_dead_letter_events`,
WO-034) regardless of circuit state. The two mechanisms serve different
purposes: the in-memory buffer avoids a DLQ write (and the associated
Postgres round-trip) for what's usually a brief Kafka blip; the DLQ is
what survives a process restart or a genuinely prolonged outage.

## HMAC replay protection (`X-Timestamp`)

`HmacValidationMiddleware` now enforces a 5-minute freshness window on
an optional `X-Timestamp` header (Unix epoch milliseconds) — reject if
more than 5 minutes old OR more than 5 minutes in the future (clock-skew
abuse guard). Deliberately **optional, not required**: making it
mandatory would break every existing LangChain/CrewAI/AutoGen/REST
client built against WO-034's originally-shipped contract, none of which
send this header today. A client that adopts `X-Timestamp` gets real,
strictly-enforced replay protection; one that doesn't is unaffected —
same backward-compatible opt-in shape as the header's absence already
having no security implication before this WO (there was no timestamp
check at all).
