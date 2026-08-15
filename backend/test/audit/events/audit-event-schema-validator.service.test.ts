import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuditEventSchemaValidatorService } from "../../../src/audit/events/audit-event-schema-validator.service";
import { ActorType, type CanonicalAuditEvent } from "../../../src/audit/events/canonical-audit-event";

function validEvent(overrides: Partial<CanonicalAuditEvent> = {}): CanonicalAuditEvent {
  return {
    event_id: randomUUID(),
    actor_id: randomUUID(),
    actor_type: ActorType.USER,
    tenant_id: randomUUID(),
    action: "user.login",
    resource_type: "session",
    resource_id: randomUUID(),
    data_classification: "internal",
    ip_address: "203.0.113.7",
    change_details: {},
    correlation_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

test("a fully valid canonical audit event passes", () => {
  const validator = new AuditEventSchemaValidatorService();
  const result = validator.validate(validEvent());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("nullable fields (actor_id, resource_id, data_classification, ip_address, correlation_id) are accepted as null", () => {
  const validator = new AuditEventSchemaValidatorService();
  const result = validator.validate(
    validEvent({ actor_id: null, actor_type: ActorType.SYSTEM, resource_id: null, data_classification: null, ip_address: null, correlation_id: null }),
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("rejects an unrecognized actor_type", () => {
  const validator = new AuditEventSchemaValidatorService();
  const result = validator.validate(validEvent({ actor_type: "superuser" as any }));
  assert.equal(result.valid, false);
});

test("rejects an unrecognized data_classification value", () => {
  const validator = new AuditEventSchemaValidatorService();
  const result = validator.validate(validEvent({ data_classification: "top-secret" as any }));
  assert.equal(result.valid, false);
});

test("rejects a payload missing a required field", () => {
  const validator = new AuditEventSchemaValidatorService();
  const event = validEvent() as any;
  delete event.action;
  const result = validator.validate(event);
  assert.equal(result.valid, false);
});

test("rejects additional, undocumented fields", () => {
  const validator = new AuditEventSchemaValidatorService();
  const result = validator.validate({ ...validEvent(), extra_field: "not allowed" } as any);
  assert.equal(result.valid, false);
});

test("rejects a non-UUID event_id/tenant_id", () => {
  const validator = new AuditEventSchemaValidatorService();
  assert.equal(validator.validate(validEvent({ event_id: "not-a-uuid" })).valid, false);
  assert.equal(validator.validate(validEvent({ tenant_id: "not-a-uuid" })).valid, false);
});
