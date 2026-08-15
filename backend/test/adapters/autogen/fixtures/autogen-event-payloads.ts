import { randomUUID } from "node:crypto";
import type { AutoGenEvent, AutoGenTelemetryEnvelope } from "../../../../src/adapters/autogen/types/autogen-event.types";

export function envelope(event: AutoGenEvent, overrides: Partial<Omit<AutoGenTelemetryEnvelope, "event">> = {}): AutoGenTelemetryEnvelope {
  return { agent_id: randomUUID(), tenant_id: randomUUID(), adapter_version: "1.0.0", ...overrides, event };
}

const CONVERSATION_ID = "conv-001";
const NESTED_CONVERSATION_ID = "conv-nested-001";
const CALL_ID = "call-001";
const GROUP_CHAT_ID = "groupchat-001";

const T0 = "2026-08-15T10:00:00.000Z";
const T1 = "2026-08-15T10:00:01.800Z"; // +1800ms

export const CONVERSATION_START: AutoGenEvent = { type: "conversation_start", conversation_id: CONVERSATION_ID, timestamp: T0, initiator_agent: "user_proxy" };
export const CONVERSATION_END: AutoGenEvent = { type: "conversation_end", conversation_id: CONVERSATION_ID, timestamp: T1 };

export const NESTED_CONVERSATION_START: AutoGenEvent = { type: "nested_conversation_start", conversation_id: NESTED_CONVERSATION_ID, timestamp: T0, parent_conversation_id: CONVERSATION_ID, nesting_level: 1 };
export const NESTED_CONVERSATION_END: AutoGenEvent = { type: "nested_conversation_end", conversation_id: NESTED_CONVERSATION_ID, timestamp: T1, parent_conversation_id: CONVERSATION_ID, nesting_level: 1 };

export const AGENT_MESSAGE: AutoGenEvent = { type: "agent_message", conversation_id: CONVERSATION_ID, timestamp: T0, sender_agent: "user_proxy", receiver_agent: "assistant", message_sequence_number: 1, content: "Please research the topic" };

export const FUNCTION_CALL: AutoGenEvent = { type: "function_call", conversation_id: CONVERSATION_ID, timestamp: T0, call_id: CALL_ID, sender_agent: "assistant", function_name: "search_web", arguments: { query: "weather" } };
export const FUNCTION_RESULT_SUCCESS: AutoGenEvent = { type: "function_result", conversation_id: CONVERSATION_ID, timestamp: T1, call_id: CALL_ID, sender_agent: "assistant", function_name: "search_web", success: true };
export const FUNCTION_RESULT_FAILURE: AutoGenEvent = {
  type: "function_result",
  conversation_id: CONVERSATION_ID,
  timestamp: T1,
  call_id: CALL_ID,
  sender_agent: "assistant",
  function_name: "search_web",
  success: false,
  error: { message: "function failed: rate limited for SSN 123-45-6789 request", name: "RateLimitError" },
};

export const GROUP_CHAT_MESSAGE: AutoGenEvent = {
  type: "group_chat_message",
  conversation_id: CONVERSATION_ID,
  timestamp: T0,
  group_chat_id: GROUP_CHAT_ID,
  sender_agent: "planner",
  participants: ["planner", "coder", "reviewer"],
  orchestrator: "group_chat_manager",
  message_sequence_number: 1,
};

export const MALFORMED_ENVELOPE = { agent_id: randomUUID() }; // missing tenant_id/adapter_version/event

/** A full multi-agent GroupChat conversation trace: conversation start -> group chat message -> function call -> function result -> nested conversation -> conversation end. */
export function fullConversationTrace(): AutoGenEvent[] {
  return [CONVERSATION_START, GROUP_CHAT_MESSAGE, FUNCTION_CALL, FUNCTION_RESULT_SUCCESS, NESTED_CONVERSATION_START, NESTED_CONVERSATION_END, CONVERSATION_END];
}
