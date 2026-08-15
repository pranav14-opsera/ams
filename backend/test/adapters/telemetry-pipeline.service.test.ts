import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";
import { DataClassificationTagger } from "../../src/classification/data-classification-tagger";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { TelemetryPipelineService } from "../../src/adapters/pipeline/telemetry-pipeline.service";
import { TelemetrySchemaValidatorService } from "../../src/adapters/telemetry-schema-validator.service";
import type { CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";

function validEvent(overrides: Partial<CanonicalTelemetryEvent> = {}): CanonicalTelemetryEvent {
  return {
    event_id: randomUUID(),
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: "trace" as any,
    latency_ms: 120,
    error_rate: 0.01,
    token_consumption: 450,
    tool_call_success: true,
    tool_call_name: "lookup_patient",
    framework_type: "langchain",
    adapter_version: "1.0.0",
    raw_payload_hash: "a".repeat(64),
    metadata: {},
    ...overrides,
  };
}

function fakeTenantRepository(settings: Record<string, unknown> | null = null) {
  return { findById: async () => ({ id: "t1", settings }) } as any;
}

function fakePublisher(behavior: "succeed" | "fail" = "succeed") {
  const published: CanonicalTelemetryEvent[] = [];
  return {
    published,
    publish: async (event: CanonicalTelemetryEvent) => {
      if (behavior === "fail") throw new Error("broker unreachable");
      published.push(event);
    },
  } as any;
}

function fakeDeadLetterRepository() {
  const records: Array<{ event: CanonicalTelemetryEvent; error: string }> = [];
  return { records, record: async (_client: unknown, event: CanonicalTelemetryEvent, error: string) => { records.push({ event, error }); } } as any;
}

function fakeMetricsAggregator() {
  const recorded: CanonicalTelemetryEvent[] = [];
  return { recorded, recordCanonicalEvent: async (_client: unknown, event: CanonicalTelemetryEvent) => { recorded.push(event); } } as any;
}

function buildPipeline(opts: { publisher?: "succeed" | "fail"; tenantSettings?: Record<string, unknown> | null } = {}) {
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());
  const phiScrubber = new PhiScrubberService();
  const publisher = fakePublisher(opts.publisher ?? "succeed");
  const deadLetter = fakeDeadLetterRepository();
  const metricsAggregator = fakeMetricsAggregator();
  const pipeline = new TelemetryPipelineService(
    {} as any,
    new TelemetrySchemaValidatorService(),
    fakeTenantRepository(opts.tenantSettings),
    tagger,
    phiScrubber,
    publisher,
    deadLetter,
    metricsAggregator,
  );
  return { pipeline, publisher, deadLetter, metricsAggregator };
}

test("a valid event is published and the response reports its classification tier and deadLettered:false", async () => {
  const { pipeline, publisher } = buildPipeline();
  const event = validEvent();
  const result = await pipeline.process(undefined, event);

  assert.equal(result.accepted, true);
  assert.equal(result.eventId, event.event_id);
  assert.equal(result.deadLettered, false);
  assert.equal(result.dataClassification, "internal", "agent_metrics resourceType classifies as INTERNAL by the platform default rules");
  assert.equal(publisher.published.length, 1);
});

test("an event failing schema validation is rejected with 400 and never reaches the publisher", async () => {
  const { pipeline, publisher } = buildPipeline();
  const invalidEvent = { ...validEvent(), latency_ms: "not-a-number" } as any;

  await assert.rejects(
    () => pipeline.process(undefined, invalidEvent),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
  assert.equal(publisher.published.length, 0);
});

test("schema validation errors never include the raw payload's own field values", async () => {
  const { pipeline } = buildPipeline();
  const invalidEvent = { ...validEvent(), tool_call_name: "SENSITIVE_TOOL_CALL_NAME_VALUE", latency_ms: "not-a-number" } as any;

  await assert.rejects(
    () => pipeline.process(undefined, invalidEvent),
    (err: any) => {
      const body = err.getResponse();
      assert.ok(!JSON.stringify(body).includes("SENSITIVE_TOOL_CALL_NAME_VALUE"));
      return true;
    },
  );
});

test("PHI-shaped content in metadata is masked before publication", async () => {
  const { pipeline, publisher } = buildPipeline();
  const event = validEvent({ metadata: { patient_ssn: "123-45-6789", note: "call back tomorrow" } });

  await pipeline.process(undefined, event);

  const published = publisher.published[0];
  assert.notEqual(published.metadata.patient_ssn, "123-45-6789");
  assert.equal(published.metadata.note, "call back tomorrow", "non-PHI-shaped content must pass through unscrubbed");
});

test("when Kafka publication fails, the event is written to the dead-letter queue and the response reports deadLettered:true", async () => {
  const { pipeline, publisher, deadLetter } = buildPipeline({ publisher: "fail" });
  const event = validEvent();

  const result = await pipeline.process(undefined, event);

  assert.equal(result.deadLettered, true);
  assert.equal(publisher.published.length, 0);
  assert.equal(deadLetter.records.length, 1);
  assert.equal(deadLetter.records[0].event.event_id, event.event_id);
  assert.match(deadLetter.records[0].error, /broker unreachable/);
});

test("tenant enrichment passes the tenant's own PHI pattern overrides through to the scrubber", async () => {
  const { pipeline, publisher } = buildPipeline({ tenantSettings: { phiFieldNamePatterns: ["custom_secret_field"] } });
  const event = validEvent({ metadata: { custom_secret_field: "should-be-masked" } });

  await pipeline.process(undefined, event);

  assert.notEqual(publisher.published[0].metadata.custom_secret_field, "should-be-masked");
});

test("every processed event is handed to the metrics aggregator (WO-041), regardless of Kafka publish outcome", async () => {
  const { pipeline: succeedingPipeline, metricsAggregator: succeedingAggregator } = buildPipeline({ publisher: "succeed" });
  const succeedEvent = validEvent();
  await succeedingPipeline.process(undefined, succeedEvent);
  assert.equal(succeedingAggregator.recorded.length, 1);
  assert.equal(succeedingAggregator.recorded[0].event_id, succeedEvent.event_id);

  const { pipeline: failingPipeline, metricsAggregator: failingAggregator } = buildPipeline({ publisher: "fail" });
  const failEvent = validEvent();
  await failingPipeline.process(undefined, failEvent);
  assert.equal(failingAggregator.recorded.length, 1, "metrics must still be recorded even when the Kafka publish itself fails");
});
