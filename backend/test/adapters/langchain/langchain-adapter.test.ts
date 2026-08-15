import { test } from "node:test";
import assert from "node:assert/strict";
import { LangChainAdapter } from "../../../src/adapters/langchain/langchain-adapter";
import { LangChainConnectionValidator } from "../../../src/adapters/langchain/langchain-connection-validator";
import { TelemetryEventType } from "../../../src/adapters/schemas/canonical-telemetry";
import { TelemetrySchemaValidatorService } from "../../../src/adapters/telemetry-schema-validator.service";
import * as fixtures from "./fixtures/langchain-callback-payloads";

function buildAdapter(): LangChainAdapter {
  return new LangChainAdapter(new LangChainConnectionValidator());
}

test("getAdapterMetadata reports langchain, a version, and TRACE/METRIC/ERROR support (no heartbeat)", () => {
  const metadata = buildAdapter().getAdapterMetadata();
  assert.equal(metadata.frameworkType, "langchain");
  assert.ok(metadata.adapterVersion);
  assert.deepEqual(new Set(metadata.supportedEventTypes), new Set([TelemetryEventType.TRACE, TelemetryEventType.METRIC, TelemetryEventType.ERROR]));
});

test("on_chain_start translates to a TRACE event with latency_ms: null", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.CHAIN_START));
  assert.equal(result.event_type, TelemetryEventType.TRACE);
  assert.equal(result.latency_ms, null);
  assert.equal(result.error_rate, null);
});

test("on_chain_end computes latency from the correlated on_chain_start timestamp", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.CHAIN_START);
  adapter.translateTelemetry(env);
  const endResult = adapter.translateTelemetry({ ...env, event: fixtures.CHAIN_END });
  assert.equal(endResult.event_type, TelemetryEventType.METRIC);
  assert.equal(endResult.latency_ms, 450);
  assert.equal(endResult.error_rate, 0);
});

test("on_chain_end without a prior on_chain_start returns latency_ms: null (never throws)", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.CHAIN_END));
  assert.equal(result.latency_ms, null);
});

test("on_chain_error translates to an ERROR event with error_rate 1 and the error message preserved in metadata", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.CHAIN_START);
  adapter.translateTelemetry(env);
  const errorResult = adapter.translateTelemetry({ ...env, event: fixtures.CHAIN_ERROR });
  assert.equal(errorResult.event_type, TelemetryEventType.ERROR);
  assert.equal(errorResult.error_rate, 1);
  assert.equal(errorResult.latency_ms, 450);
  assert.match((errorResult.metadata as any).error, /upstream timeout/);
});

test("on_llm_start/on_llm_end round-trip: latency computed, legacy token_usage format extracted", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.LLM_START);
  adapter.translateTelemetry(env);
  const endResult = adapter.translateTelemetry({ ...env, event: fixtures.LLM_END_LEGACY_TOKEN_FORMAT });
  assert.equal(endResult.event_type, TelemetryEventType.METRIC);
  assert.equal(endResult.latency_ms, 450);
  assert.equal(endResult.token_consumption, 200);
});

test("on_llm_end extracts the newer usage_metadata token format, preferring it over legacy when both could apply", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.LLM_END_NEW_TOKEN_FORMAT));
  assert.equal(result.token_consumption, 220);
});

test("on_llm_end with neither token format present falls back to token_consumption: null", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.LLM_END_NO_TOKEN_DATA));
  assert.equal(result.token_consumption, null);
});

test("on_llm_error translates to an ERROR event; the (pre-scrub) error message is carried in metadata for the pipeline's own PHI scrubber to mask later", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.LLM_ERROR));
  assert.equal(result.event_type, TelemetryEventType.ERROR);
  assert.equal(result.error_rate, 1);
  assert.match((result.metadata as any).error, /rate limit exceeded/);
});

test("on_tool_start/on_tool_end: tool_call_name and tool_call_success are populated", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.TOOL_START);
  const startResult = adapter.translateTelemetry(env);
  assert.equal(startResult.tool_call_name, "web_search");
  assert.equal(startResult.tool_call_success, null);

  const endResult = adapter.translateTelemetry({ ...env, event: fixtures.TOOL_END });
  assert.equal(endResult.tool_call_name, "web_search");
  assert.equal(endResult.tool_call_success, true);
  assert.equal(endResult.latency_ms, 450);
});

test("on_tool_error: tool_call_success is false", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.TOOL_START);
  adapter.translateTelemetry(env);
  const result = adapter.translateTelemetry({ ...env, event: fixtures.TOOL_ERROR });
  assert.equal(result.event_type, TelemetryEventType.ERROR);
  assert.equal(result.tool_call_success, false);
});

test("on_retriever_start/on_retriever_end: document count surfaced in metadata", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.RETRIEVER_START);
  adapter.translateTelemetry(env);
  const result = adapter.translateTelemetry({ ...env, event: fixtures.RETRIEVER_END });
  assert.equal(result.event_type, TelemetryEventType.METRIC);
  assert.equal((result.metadata as any).documentCount, 3);
});

test("every translated event carries the agent_id/tenant_id from the envelope and a raw_payload_hash", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.LLM_START, { agent_id: "agent-xyz", tenant_id: "tenant-xyz" });
  const result = adapter.translateTelemetry(env);
  assert.equal(result.agent_id, "agent-xyz");
  assert.equal(result.tenant_id, "tenant-xyz");
  assert.match(result.raw_payload_hash, /^[a-f0-9]{64}$/);
});

test("throws (400) on a malformed envelope missing required fields", () => {
  const adapter = buildAdapter();
  assert.throws(
    () => adapter.translateTelemetry(fixtures.MALFORMED_ENVELOPE),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("throws (400) on a completely unrecognized event type", () => {
  const adapter = buildAdapter();
  const malformed = { agent_id: "a", tenant_id: "t", adapter_version: "1.0.0", event: { type: "on_something_unheard_of", run_id: "r", timestamp: new Date().toISOString() } };
  assert.throws(
    () => adapter.translateTelemetry(malformed),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("every successfully translated fixture event passes canonical schema validation", () => {
  const adapter = buildAdapter();
  const validator = new TelemetrySchemaValidatorService();
  const events = [
    fixtures.CHAIN_START,
    fixtures.CHAIN_END,
    fixtures.CHAIN_ERROR,
    fixtures.LLM_START,
    fixtures.LLM_END_LEGACY_TOKEN_FORMAT,
    fixtures.LLM_ERROR,
    fixtures.TOOL_START,
    fixtures.TOOL_END,
    fixtures.TOOL_ERROR,
    fixtures.RETRIEVER_START,
    fixtures.RETRIEVER_END,
  ];
  assert.equal(events.length, 11, "this WO's own implementation_steps call for 11 callback type translations");
  for (const event of events) {
    const result = validator.validate(adapter.translateTelemetry(fixtures.envelope(event)));
    assert.equal(result.valid, true, `${event.type} must translate into a schema-valid canonical event: ${result.errors.join("; ")}`);
  }
});
