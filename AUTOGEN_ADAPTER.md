# AutoGen Adapter (WO-038)

Translates Microsoft AutoGen's conversational message-passing model
(agent ↔ agent messages, GroupChat orchestration, function calls, nested
conversations) into the platform's canonical schema (WO-034). See
[TELEMETRY_PIPELINE.md](TELEMETRY_PIPELINE.md) for the shared ingestion
pipeline every framework adapter feeds into.

## What it maps

| AutoGen event | Canonical `event_type` | Notes |
|---|---|---|
| `conversation_start` | `trace` | Records `conversation_id` → timestamp for latency correlation. `metadata.parentConversationId: null, nestingLevel: 0`. |
| `conversation_end` | `metric` | `latency_ms` from the correlated `conversation_start`. |
| `nested_conversation_start` | `trace` | Its own `conversation_id`, correlated independently of the outer conversation. `metadata` carries `parentConversationId` + `nestingLevel`. |
| `nested_conversation_end` | `metric` | `latency_ms` from the correlated nested start. |
| `agent_message` | `trace` | `metadata`: `conversationId`, `senderAgent`, `receiverAgent`, `messageSequenceNumber`. |
| `function_call` | `trace` | `tool_call_name` = `function_name`. Records `call_id` → timestamp. |
| `function_result` | `metric` (success) / `error` (failure) | `latency_ms` from the correlated `function_call`; `tool_call_success` set directly; failure's `error.message` carried in `metadata.error` (PHI-scrubbed by the shared pipeline, not the adapter). |
| `group_chat_message` | `trace` | `metadata`: `groupChatId`, `participants` (full list), `orchestrator`, `senderAgent`, `messageSequenceNumber`. |

`agent_id`/`tenant_id` aren't AutoGen concepts — same envelope-wrapping
approach as the LangChain/CrewAI adapters (see
[LANGCHAIN_ADAPTER.md](LANGCHAIN_ADAPTER.md)).

## Client-side integration sketch

Wire a telemetry emitter into AutoGen's own message/function-call hooks
(e.g. a custom `ConversableAgent` subclass or a `hook_lists` callback,
depending on your AutoGen version):

```python
telemetry.emit({"type": "conversation_start", "conversation_id": conv_id, "timestamp": now(), "initiator_agent": "user_proxy"})
telemetry.emit({"type": "agent_message", "conversation_id": conv_id, "timestamp": now(), "sender_agent": "user_proxy", "receiver_agent": "assistant", "message_sequence_number": 1})
telemetry.emit({"type": "function_call", "conversation_id": conv_id, "timestamp": now(), "call_id": call_id, "sender_agent": "assistant", "function_name": "search_web", "arguments": {...}})
telemetry.emit({"type": "function_result", "conversation_id": conv_id, "timestamp": now(), "call_id": call_id, "sender_agent": "assistant", "function_name": "search_web", "success": True})
telemetry.emit({"type": "group_chat_message", "conversation_id": conv_id, "timestamp": now(), "group_chat_id": gc_id, "sender_agent": "planner", "participants": ["planner", "coder", "reviewer"], "orchestrator": "group_chat_manager", "message_sequence_number": 1})
telemetry.emit({"type": "conversation_end", "conversation_id": conv_id, "timestamp": now()})
```

`telemetry.emit()` here is the same `PlatformTelemetryEmitter` pattern
documented in [CREWAI_ADAPTER.md](CREWAI_ADAPTER.md) — wraps each event
in `{agent_id, tenant_id, adapter_version, event}` and POSTs it with an
HMAC-SHA256 `X-Signature-256` signature to
`/api/v1/adapters/autogen/telemetry`.

## Connection validation & health probes

`AutoGenConnectionValidator` sends a `GET {configEndpoint}` request (60s
timeout for registration-time `validateConnection()`, 10s for ad-hoc
`checkAgentHealth()`). An optional `apiKey` in `connection_config` is
sent as a Bearer token.
