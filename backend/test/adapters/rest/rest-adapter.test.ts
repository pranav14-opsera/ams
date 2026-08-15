import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GenericRestAdapter } from "../../../src/adapters/rest/rest-adapter";
import { RestConnectionValidator } from "../../../src/adapters/rest/rest-connection-validator";
import { RestTelemetryValidatorService } from "../../../src/adapters/rest/rest-telemetry-validator.service";
import { TelemetryEventType } from "../../../src/adapters/schemas/canonical-telemetry";
import { TelemetrySchemaValidatorService } from "../../../src/adapters/telemetry-schema-validator.service";
import * as fixtures from "./fixtures/rest-telemetry-payloads";

function buildAdapter(): GenericRestAdapter {
  return new GenericRestAdapter(new RestConnectionValidator(), new RestTelemetryValidatorService());
}

test("getAdapterMetadata reports generic_rest and all 4 event types (the universal fallback)", () => {
  const metadata = buildAdapter().getAdapterMetadata();
  assert.equal(metadata.frameworkType, "generic_rest");
  assert.deepEqual(new Set(metadata.supportedEventTypes), new Set([TelemetryEventType.HEARTBEAT, TelemetryEventType.METRIC, TelemetryEventType.TRACE, TelemetryEventType.ERROR]));
});

test("translates an event using canonical field names with minimal changes", () => {
  const adapter = buildAdapter();
  const input = fixtures.canonicalNamedEvent();
  const result = adapter.translateTelemetry(input);
  assert.equal(result.agent_id, input.agent_id);
  assert.equal(result.tenant_id, input.tenant_id);
  assert.equal(result.latency_ms, 150);
  assert.equal(result.token_consumption, 300);
  assert.equal(result.tool_call_name, "fetch_data");
});

test("resolves duration_ms and tokens aliases to latency_ms/token_consumption", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.aliasNamedEvent());
  assert.equal(result.latency_ms, 90);
  assert.equal(result.token_consumption, 50);
});

test("canonical field name wins over its alias when both are supplied", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry({ agent_id: randomUUID(), tenant_id: randomUUID(), event_type: "metric", latency_ms: 200, duration_ms: 999 });
  assert.equal(result.latency_ms, 200);
});

test("fills in defaults for event_id, timestamp, adapter_version, raw_payload_hash, and metadata when omitted", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.MINIMAL_VALID_EVENT);
  assert.ok(result.event_id);
  assert.ok(result.timestamp);
  assert.ok(result.adapter_version);
  assert.match(result.raw_payload_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.metadata, {});
  assert.equal(result.latency_ms, null);
  assert.equal(result.token_consumption, null);
});

test("every valid fixture translates into a canonical-schema-valid event", () => {
  const adapter = buildAdapter();
  const validator = new TelemetrySchemaValidatorService();
  for (const input of [fixtures.canonicalNamedEvent(), fixtures.aliasNamedEvent(), fixtures.MINIMAL_VALID_EVENT]) {
    const result = validator.validate(adapter.translateTelemetry(input));
    assert.equal(result.valid, true, result.errors.join("; "));
  }
});

test("throws 400 for a payload missing a required field (agent_id)", () => {
  const adapter = buildAdapter();
  assert.throws(
    () => adapter.translateTelemetry(fixtures.INVALID_MISSING_AGENT_ID),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("throws 400 for an unrecognized event_type", () => {
  const adapter = buildAdapter();
  assert.throws(
    () => adapter.translateTelemetry(fixtures.INVALID_UNKNOWN_EVENT_TYPE),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("throws 400 for an undocumented extra field (additionalProperties: false)", () => {
  const adapter = buildAdapter();
  assert.throws(
    () => adapter.translateTelemetry(fixtures.INVALID_EXTRA_FIELD),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("400 responses include detailed, field-path-referencing validation errors", () => {
  const adapter = buildAdapter();
  try {
    adapter.translateTelemetry(fixtures.INVALID_MISSING_AGENT_ID);
    assert.fail("expected translateTelemetry to throw");
  } catch (err: any) {
    const body = err.getResponse();
    assert.equal(body.error, "validation_error");
    assert.ok(Array.isArray(body.details) && body.details.length > 0);
    assert.ok(body.details.some((d: string) => d.includes("agent_id")));
  }
});
