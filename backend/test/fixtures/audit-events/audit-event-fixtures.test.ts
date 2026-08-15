import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuditEventSchemaValidatorService } from "../../../src/audit/events/audit-event-schema-validator.service";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { ActorType, type CanonicalAuditEvent } from "../../../src/audit/events/canonical-audit-event";
import fixtures from "./audit-event-fixtures.json";

function toCanonicalEvent(template: (typeof fixtures.events)[number]): CanonicalAuditEvent {
  return {
    event_id: randomUUID(),
    actor_id: template.actor_type === "user" ? randomUUID() : null,
    actor_type: template.actor_type as ActorType,
    tenant_id: randomUUID(),
    action: template.action,
    resource_type: template.resource_type,
    resource_id: randomUUID(),
    data_classification: template.data_classification,
    ip_address: null,
    change_details: template.change_details,
    correlation_id: randomUUID(),
    occurred_at: new Date().toISOString(),
  };
}

test("WO-046 AC: at least 50 fixture events are committed, at least 15 with embedded PHI", () => {
  assert.ok(fixtures.events.length >= 50, `expected at least 50 events, got ${fixtures.events.length}`);
  const phiCount = fixtures.events.filter((e) => e.has_phi).length;
  assert.ok(phiCount >= 15, `expected at least 15 PHI-bearing events, got ${phiCount}`);
});

test("every fixture event, once assigned real IDs, passes the canonical audit event schema", () => {
  const validator = new AuditEventSchemaValidatorService();
  for (const template of fixtures.events) {
    const event = toCanonicalEvent(template);
    const result = validator.validate(event);
    assert.equal(result.valid, true, `fixture "${template.name}" failed schema validation: ${JSON.stringify(result.errors)}`);
  }
});

test("every PHI-flagged fixture event is fully masked by the scrubber (field + embedded-text passes)", () => {
  const scrubber = new PhiScrubberService();
  for (const template of fixtures.events.filter((e) => e.has_phi)) {
    const fieldScrubbed = scrubber.scrub(template.change_details) as Record<string, unknown>;
    const fullyScrubbed = scrubber.scrubEmbeddedText(fieldScrubbed);
    const serialized = JSON.stringify(fullyScrubbed);

    assert.ok(!serialized.includes("Jane Doe"), `fixture "${template.name}": patient name must not survive`);
    assert.ok(!/\d{3}-\d{2}-\d{4}/.test(serialized), `fixture "${template.name}": SSN-shaped value must not survive`);
    assert.ok(!serialized.includes("TEST-MRN-12345"), `fixture "${template.name}": MRN must not survive`);
    assert.ok(!serialized.includes("1900-01-01") && !serialized.includes("1990-01-01"), `fixture "${template.name}": DOB must not survive`);
    assert.ok(!serialized.includes("example.com"), `fixture "${template.name}": email must not survive`);
    assert.ok(!serialized.includes("000-000-0000"), `fixture "${template.name}": phone must not survive`);
  }
});

test("non-PHI fixture events pass through the scrubber completely unchanged", () => {
  const scrubber = new PhiScrubberService();
  for (const template of fixtures.events.filter((e) => !e.has_phi)) {
    const fieldScrubbed = scrubber.scrub(template.change_details) as Record<string, unknown>;
    const fullyScrubbed = scrubber.scrubEmbeddedText(fieldScrubbed);
    assert.deepEqual(fullyScrubbed, template.change_details, `fixture "${template.name}" is marked non-PHI but the scrubber changed it`);
  }
});
