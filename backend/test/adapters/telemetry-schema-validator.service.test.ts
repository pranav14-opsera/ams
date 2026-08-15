import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { TelemetrySchemaValidatorService } from "../../src/adapters/telemetry-schema-validator.service";
import type { CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";

function validEvent(overrides: Partial<CanonicalTelemetryEvent> = {}): CanonicalTelemetryEvent {
  return {
    event_id: randomUUID(),
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: "metric" as any,
    latency_ms: 120,
    error_rate: 0.01,
    token_consumption: 450,
    tool_call_success: true,
    tool_call_name: "search_docs",
    framework_type: "langchain",
    adapter_version: "1.0.0",
    raw_payload_hash: createHash("sha256").update("payload").digest("hex"),
    metadata: { region: "us" },
    ...overrides,
  };
}

test("accepts a fully valid canonical telemetry event", () => {
  const validator = new TelemetrySchemaValidatorService();
  const result = validator.validate(validEvent());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects an event missing a required field", () => {
  const validator = new TelemetrySchemaValidatorService();
  const event = validEvent() as any;
  delete event.agent_id;
  const result = validator.validate(event);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("agent_id")));
});

test("rejects an event with an extra, undocumented property (additionalProperties: false)", () => {
  const validator = new TelemetrySchemaValidatorService();
  const event = { ...validEvent(), unexpected_field: "surprise" };
  const result = validator.validate(event);
  assert.equal(result.valid, false);
});

test("rejects an event with the wrong type for a field (latency_ms as a string)", () => {
  const validator = new TelemetrySchemaValidatorService();
  const event = validEvent({ latency_ms: "fast" as any });
  const result = validator.validate(event);
  assert.equal(result.valid, false);
});

test("rejects an invalid event_type value", () => {
  const validator = new TelemetrySchemaValidatorService();
  const event = validEvent({ event_type: "not-a-real-event-type" as any });
  const result = validator.validate(event);
  assert.equal(result.valid, false);
});

test("rejects a malformed raw_payload_hash (not a 64-char hex digest)", () => {
  const validator = new TelemetrySchemaValidatorService();
  const event = validEvent({ raw_payload_hash: "not-a-hash" });
  const result = validator.validate(event);
  assert.equal(result.valid, false);
});

test("accepts explicit nulls for the nullable numeric/optional fields (e.g. a heartbeat event)", () => {
  const validator = new TelemetrySchemaValidatorService();
  const event = validEvent({
    event_type: "heartbeat" as any,
    latency_ms: null,
    error_rate: null,
    token_consumption: null,
    tool_call_success: null,
    tool_call_name: null,
  });
  const result = validator.validate(event);
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("error messages reference field paths, never raw field values", () => {
  const validator = new TelemetrySchemaValidatorService();
  const event = validEvent({ latency_ms: "SENSITIVE_VALUE_SHOULD_NOT_APPEAR" as any });
  const result = validator.validate(event);
  assert.ok(!result.errors.some((e) => e.includes("SENSITIVE_VALUE_SHOULD_NOT_APPEAR")));
});
