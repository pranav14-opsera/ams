import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoGenAdapter } from "../../../src/adapters/autogen/autogen-adapter";
import { AutoGenConnectionValidator } from "../../../src/adapters/autogen/autogen-connection-validator";
import { TelemetryEventType } from "../../../src/adapters/schemas/canonical-telemetry";
import { TelemetrySchemaValidatorService } from "../../../src/adapters/telemetry-schema-validator.service";
import * as fixtures from "./fixtures/autogen-event-payloads";

function buildAdapter(): AutoGenAdapter {
  return new AutoGenAdapter(new AutoGenConnectionValidator());
}

test("getAdapterMetadata reports autogen and TRACE/METRIC/ERROR support", () => {
  const metadata = buildAdapter().getAdapterMetadata();
  assert.equal(metadata.frameworkType, "autogen");
  assert.deepEqual(new Set(metadata.supportedEventTypes), new Set([TelemetryEventType.TRACE, TelemetryEventType.METRIC, TelemetryEventType.ERROR]));
});

test("conversation_start/conversation_end round-trip: latency computed from the correlated start", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.CONVERSATION_START);
  const startResult = adapter.translateTelemetry(env);
  assert.equal(startResult.event_type, TelemetryEventType.TRACE);
  assert.equal(startResult.latency_ms, null);
  assert.equal((startResult.metadata as any).initiatorAgent, "user_proxy");

  const endResult = adapter.translateTelemetry({ ...env, event: fixtures.CONVERSATION_END });
  assert.equal(endResult.event_type, TelemetryEventType.METRIC);
  assert.equal(endResult.latency_ms, 1800);
});

test("conversation_end without a prior conversation_start returns latency_ms: null (never throws)", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.CONVERSATION_END));
  assert.equal(result.latency_ms, null);
});

test("nested_conversation_start/end preserve parentConversationId and nestingLevel, correlated independently of the outer conversation", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.NESTED_CONVERSATION_START);
  const startResult = adapter.translateTelemetry(env);
  assert.equal((startResult.metadata as any).parentConversationId, "conv-001");
  assert.equal((startResult.metadata as any).nestingLevel, 1);

  const endResult = adapter.translateTelemetry({ ...env, event: fixtures.NESTED_CONVERSATION_END });
  assert.equal(endResult.latency_ms, 1800);
  assert.equal((endResult.metadata as any).parentConversationId, "conv-001");
});

test("agent_message preserves conversationId, senderAgent, receiverAgent, and messageSequenceNumber", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.AGENT_MESSAGE));
  assert.equal(result.event_type, TelemetryEventType.TRACE);
  const metadata = result.metadata as any;
  assert.equal(metadata.senderAgent, "user_proxy");
  assert.equal(metadata.receiverAgent, "assistant");
  assert.equal(metadata.messageSequenceNumber, 1);
});

test("function_call maps function_name to tool_call_name; function_result (success) computes latency and sets tool_call_success", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.FUNCTION_CALL);
  const callResult = adapter.translateTelemetry(env);
  assert.equal(callResult.tool_call_name, "search_web");
  assert.equal(callResult.tool_call_success, null);

  const resultEvent = adapter.translateTelemetry({ ...env, event: fixtures.FUNCTION_RESULT_SUCCESS });
  assert.equal(resultEvent.event_type, TelemetryEventType.METRIC);
  assert.equal(resultEvent.tool_call_success, true);
  assert.equal(resultEvent.tool_call_name, "search_web");
  assert.equal(resultEvent.latency_ms, 1800);
  assert.equal(resultEvent.error_rate, 0);
});

test("function_result (failure) maps to an ERROR event with tool_call_success: false and the error preserved in metadata", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.FUNCTION_CALL);
  adapter.translateTelemetry(env);
  const result = adapter.translateTelemetry({ ...env, event: fixtures.FUNCTION_RESULT_FAILURE });
  assert.equal(result.event_type, TelemetryEventType.ERROR);
  assert.equal(result.tool_call_success, false);
  assert.equal(result.error_rate, 1);
  assert.match((result.metadata as any).error, /rate limited/);
});

test("group_chat_message preserves groupChatId, participants list, orchestrator, and sender/sequence", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.GROUP_CHAT_MESSAGE));
  const metadata = result.metadata as any;
  assert.equal(metadata.groupChatId, "groupchat-001");
  assert.deepEqual(metadata.participants, ["planner", "coder", "reviewer"]);
  assert.equal(metadata.orchestrator, "group_chat_manager");
  assert.equal(metadata.senderAgent, "planner");
  assert.equal(metadata.messageSequenceNumber, 1);
});

test("throws 400 on a malformed envelope", () => {
  const adapter = buildAdapter();
  assert.throws(
    () => adapter.translateTelemetry(fixtures.MALFORMED_ENVELOPE),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("throws 400 on a completely unrecognized event type", () => {
  const adapter = buildAdapter();
  const malformed = { agent_id: "a", tenant_id: "t", adapter_version: "1.0.0", event: { type: "on_something_unheard_of", conversation_id: "c", timestamp: new Date().toISOString() } };
  assert.throws(
    () => adapter.translateTelemetry(malformed),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("every event type in a full conversation trace translates into a canonical-schema-valid event", () => {
  const adapter = buildAdapter();
  const validator = new TelemetrySchemaValidatorService();
  const env = fixtures.envelope(fixtures.CONVERSATION_START);
  const trace = fixtures.fullConversationTrace();
  assert.equal(trace.length, 7);
  for (const event of trace) {
    const result = validator.validate(adapter.translateTelemetry({ ...env, event }));
    assert.equal(result.valid, true, `${event.type} must translate into a schema-valid canonical event: ${result.errors.join("; ")}`);
  }
});
