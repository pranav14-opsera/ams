# Adapter Telemetry Pipeline (WO-034)

Defines the contract every framework-specific agent adapter (LangChain —
WO-035, generic REST — WO-036, CrewAI — WO-037, AutoGen — WO-038)
implements, plus the shared ingestion pipeline all of them feed into.

## Architecture

```
Raw framework event
  -> IAgentAdapter.translateTelemetry()      (framework-specific, WO-035+)
  -> HmacValidationMiddleware                 (per-agent shared secret, X-Signature-256)
  -> AdaptersController                       (POST /api/v1/adapters/:frameworkType/telemetry)
  -> TelemetryPipelineService
       1. TelemetrySchemaValidatorService (ajv, canonical-telemetry.schema.json)
       2. Tenant context enrichment (TenantRepository)
       3. DataClassificationTagger (WO-016, reused as-is)
       4. PhiScrubberService (WO-017, reused as-is — applied to `metadata`,
          the schema's one free-form field)
       5. KafkaTelemetryProducerService.publish() (tenant-partitioned)
          -> on failure: TelemetryDeadLetterRepository (Postgres DLQ)
```

- `IAgentAdapter` / `BaseAgentAdapter`: `backend/src/adapters/`
- Canonical schema: `backend/src/adapters/schemas/`
- HMAC secret: BYOK-encrypted per agent (`agents.hmac_secret_*` columns,
  migration 034), generated once at registration and revealed exactly
  once in `AgentsService.create()`'s response — never stored or returned
  in plaintext again.

## Why classification tagging doesn't gate PHI scrubbing here

WO-016/017's original pipeline (`PhiScrubberPipelineStage`) only scrubs
RESTRICTED/CONFIDENTIAL-tier events. A telemetry event's `resourceType`
(`agent_metrics`) always classifies as INTERNAL under the platform's
default rules, and the canonical schema's `additionalProperties: false`
means no field name can ever match the RESTRICTED field-name pattern
either — gating scrubbing on tier here would mean telemetry `metadata`
is *never* scrubbed, which contradicts this WO's own unconditional
"PHI scrubbing replaces detected PHI patterns... before Kafka
publication." `TelemetryPipelineService` instead applies
`PhiScrubberService.scrub()` directly and unconditionally to `metadata`
— the schema's one genuinely free-form field — while still using
`DataClassificationTagger` for the tier itself (attached to logs/DLQ
context, not injected into the wire payload, which has no schema slot
for it).

## Known environment limitation: no local Kafka broker

Real infrastructure for Kafka is planned (`infrastructure/terraform/messaging/kafka`,
an `aws_msk_cluster` resource) — this sandbox has no Docker/testcontainers
and no reachable local broker (confirmed by a direct connection probe:
`ECONNREFUSED` on `localhost:9092`), the same class of environment gap as
WO-026/028's Terraform provider handshake issue.

`KafkaTelemetryProducerService` is a genuine `kafkajs` client (not a
stub) that will connect to `KAFKA_BROKERS` in any environment where a
broker actually exists. In this sandbox, every `publish()` call
genuinely fails with a real connection error, which
`TelemetryPipelineService` catches and writes to
`telemetry_dead_letter_events` — a real Postgres table, fully exercised
end-to-end in `telemetry-pipeline-integration.test.ts` (including
verifying the PHI-scrubbed payload that actually lands there). The
message-construction/tenant-partitioning logic is unit-tested directly;
what cannot be verified in this environment is a message actually
arriving on a live Kafka topic.

## Framework adapters are out of this WO's scope

`AdapterRegistryService` ships empty in production — WO-035/036/037/038
each register their own concrete adapter. This WO's own integration test
uses a `ReferenceTestAdapter` (test-only, defined in
`telemetry-pipeline-integration.test.ts`, never registered in
`AdaptersModule`) purely to exercise the full pipeline end-to-end without
preempting any of those work orders' own scope.
