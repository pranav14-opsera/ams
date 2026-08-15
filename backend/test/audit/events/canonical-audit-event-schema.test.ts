import { test } from "node:test";
import assert from "node:assert/strict";
import canonicalAuditEventSchema from "../../../src/audit/events/canonical-audit-event.schema.json";
import { ACTOR_TYPES } from "../../../src/audit/events/canonical-audit-event";

const EXPECTED_FIELDS = [
  "event_id",
  "actor_id",
  "actor_type",
  "tenant_id",
  "action",
  "resource_type",
  "resource_id",
  "data_classification",
  "ip_address",
  "change_details",
  "correlation_id",
  "occurred_at",
];

test("the JSON Schema's properties match exactly this WO's documented canonical field list", () => {
  assert.deepEqual(new Set(Object.keys(canonicalAuditEventSchema.properties)), new Set(EXPECTED_FIELDS));
});

test("every documented field is required", () => {
  assert.deepEqual(new Set(canonicalAuditEventSchema.required), new Set(EXPECTED_FIELDS));
});

test("additionalProperties is false — the schema is strict, not just documentary", () => {
  assert.equal(canonicalAuditEventSchema.additionalProperties, false);
});

test("actor_type enum in the schema matches the ActorType TS enum exactly", () => {
  assert.deepEqual(new Set(canonicalAuditEventSchema.properties.actor_type.enum), new Set(ACTOR_TYPES));
});

test("data_classification enum matches the platform's 4 classification tiers plus null", () => {
  assert.deepEqual(new Set(canonicalAuditEventSchema.properties.data_classification.enum), new Set(["public", "internal", "confidential", "restricted", null]));
});
