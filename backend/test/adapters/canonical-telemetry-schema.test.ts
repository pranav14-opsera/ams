import { test } from "node:test";
import assert from "node:assert/strict";
import canonicalTelemetrySchema from "../../src/adapters/schemas/canonical-telemetry.schema.json";

// This WO's own acceptance criteria list an exact field set for the
// canonical schema — asserted here against both the JSON Schema's
// `properties` keys and its `required` array so the two files (the
// TypeScript interface's structural shape is exercised indirectly via
// telemetry-schema-validator.service.test.ts) can't silently drift apart.
const EXPECTED_FIELDS = [
  "event_id",
  "agent_id",
  "tenant_id",
  "timestamp",
  "event_type",
  "latency_ms",
  "error_rate",
  "token_consumption",
  "tool_call_success",
  "tool_call_name",
  "framework_type",
  "adapter_version",
  "raw_payload_hash",
  "metadata",
];

test("the JSON Schema's properties match exactly this WO's documented canonical field list", () => {
  assert.deepEqual(new Set(Object.keys(canonicalTelemetrySchema.properties)), new Set(EXPECTED_FIELDS));
});

test("every documented field is required", () => {
  assert.deepEqual(new Set(canonicalTelemetrySchema.required), new Set(EXPECTED_FIELDS));
});

test("additionalProperties is false — the schema is strict, not just documentary", () => {
  assert.equal(canonicalTelemetrySchema.additionalProperties, false);
});

test("event_type is constrained to exactly heartbeat/metric/trace/error", () => {
  assert.deepEqual(new Set(canonicalTelemetrySchema.properties.event_type.enum), new Set(["heartbeat", "metric", "trace", "error"]));
});
