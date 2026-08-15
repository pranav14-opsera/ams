import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuditEventConsumerPipelineService } from "../../../src/audit/events/audit-event-consumer-pipeline.service";
import { AuditEventSchemaValidatorService } from "../../../src/audit/events/audit-event-schema-validator.service";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { ActorType, type CanonicalAuditEvent } from "../../../src/audit/events/canonical-audit-event";

function fakeEvent(overrides: Partial<CanonicalAuditEvent> = {}): CanonicalAuditEvent {
  return {
    event_id: randomUUID(),
    actor_id: null,
    actor_type: ActorType.SYSTEM,
    tenant_id: randomUUID(),
    action: "test.action",
    resource_type: "test_resource",
    resource_id: randomUUID(),
    data_classification: "internal",
    ip_address: null,
    change_details: {},
    correlation_id: null,
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeEnrichmentService(behavior: "succeed" | "fail" = "succeed") {
  return {
    enrich: async (event: CanonicalAuditEvent) => {
      if (behavior === "fail") throw new Error("tenant not found");
      return { ...event, enriched_at: new Date().toISOString(), actor_resolved: false };
    },
  } as any;
}

function fakeAuditStoreRepository() {
  const inserted: any[] = [];
  return { inserted, insertAuditEvent: async (input: any) => { inserted.push(input); return { id: randomUUID(), recordHash: "h".repeat(64), occurredAt: new Date() }; } } as any;
}

function fakeDeadLetterRepository() {
  const records: any[] = [];
  return { records, record: async (_client: unknown, event: CanonicalAuditEvent, errorMessage: string) => { records.push({ event, errorMessage }); } } as any;
}

function buildPipeline(opts: { enrichment?: "succeed" | "fail" } = {}) {
  const schemaValidator = new AuditEventSchemaValidatorService();
  const enrichmentService = fakeEnrichmentService(opts.enrichment ?? "succeed");
  const phiScrubber = new PhiScrubberService();
  const auditStoreRepository = fakeAuditStoreRepository();
  const deadLetterRepository = fakeDeadLetterRepository();
  const pipeline = new AuditEventConsumerPipelineService(schemaValidator, enrichmentService, phiScrubber, auditStoreRepository, deadLetterRepository);
  return { pipeline, auditStoreRepository, deadLetterRepository };
}

test("a valid event is enriched, PHI-scrubbed, and persisted", async () => {
  const { pipeline, auditStoreRepository } = buildPipeline();
  const event = fakeEvent();

  const result = await pipeline.process(undefined, event);

  assert.equal(result.accepted, true);
  assert.equal(result.deadLettered, false);
  assert.ok(result.auditRowId);
  assert.equal(auditStoreRepository.inserted.length, 1);
  assert.equal(auditStoreRepository.inserted[0].tenantId, event.tenant_id);
});

test("PHI in change_details is masked before persistence", async () => {
  const { pipeline, auditStoreRepository } = buildPipeline();
  const event = fakeEvent({ change_details: { patient_ssn: "123-45-6789", note: "routine update" } });

  await pipeline.process(undefined, event);

  const persistedDetails = auditStoreRepository.inserted[0].details;
  assert.notEqual(persistedDetails.patient_ssn, "123-45-6789");
  assert.equal(persistedDetails.note, "routine update");
});

test("an event that fails schema validation is routed to the DLQ, never to the audit store", async () => {
  const { pipeline, auditStoreRepository, deadLetterRepository } = buildPipeline();
  const invalidEvent = { ...fakeEvent(), action: "" } as any; // action minLength:1

  const result = await pipeline.process(undefined, invalidEvent);

  assert.equal(result.deadLettered, true);
  assert.equal(auditStoreRepository.inserted.length, 0);
  assert.equal(deadLetterRepository.records.length, 1);
  assert.match(deadLetterRepository.records[0].errorMessage, /validation/i);
});

test("an event that fails enrichment (unknown tenant) is routed to the DLQ, never to the audit store", async () => {
  const { pipeline, auditStoreRepository, deadLetterRepository } = buildPipeline({ enrichment: "fail" });
  const event = fakeEvent();

  const result = await pipeline.process(undefined, event);

  assert.equal(result.deadLettered, true);
  assert.equal(auditStoreRepository.inserted.length, 0);
  assert.equal(deadLetterRepository.records.length, 1);
  assert.match(deadLetterRepository.records[0].errorMessage, /tenant not found/);
});

test("DLQ writes carry the ORIGINAL unscrubbed event_id for correlation, even on failure", async () => {
  const { pipeline, deadLetterRepository } = buildPipeline({ enrichment: "fail" });
  const event = fakeEvent();

  await pipeline.process(undefined, event);

  assert.equal(deadLetterRepository.records[0].event.event_id, event.event_id);
});
