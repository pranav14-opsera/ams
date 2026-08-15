import { randomUUID } from "node:crypto";
import type { LangChainCallbackEvent, LangChainTelemetryEnvelope } from "../../../../src/adapters/langchain/types/langchain-callback.types";

/**
 * Realistic LangChain callback payloads for all 11 documented event
 * types (this WO's own fixture requirement), covering both the legacy
 * (0.2.x) llm_output.token_usage shape and the newer (0.3.x)
 * usage_metadata shape, a multi-step chain execution, and error cases.
 */
export function envelope(event: LangChainCallbackEvent, overrides: Partial<Omit<LangChainTelemetryEnvelope, "event">> = {}): LangChainTelemetryEnvelope {
  return {
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    adapter_version: "1.0.0",
    ...overrides,
    event,
  };
}

const RUN_ID = "run-chain-001";
const LLM_RUN_ID = "run-llm-001";
const TOOL_RUN_ID = "run-tool-001";
const RETRIEVER_RUN_ID = "run-retriever-001";

const T0 = "2026-08-15T10:00:00.000Z";
const T1 = "2026-08-15T10:00:00.450Z"; // +450ms

export const CHAIN_START: LangChainCallbackEvent = { type: "on_chain_start", run_id: RUN_ID, timestamp: T0, serialized: { name: "AgentExecutor" } };
export const CHAIN_END: LangChainCallbackEvent = { type: "on_chain_end", run_id: RUN_ID, timestamp: T1, outputs: { result: "done" } };
export const CHAIN_ERROR: LangChainCallbackEvent = { type: "on_chain_error", run_id: RUN_ID, timestamp: T1, error: { message: "chain failed: upstream timeout", name: "TimeoutError" } };

export const LLM_START: LangChainCallbackEvent = { type: "on_llm_start", run_id: LLM_RUN_ID, timestamp: T0, serialized: { name: "ChatOpenAI" }, prompts: ["Summarize this document."] };
export const LLM_END_LEGACY_TOKEN_FORMAT: LangChainCallbackEvent = {
  type: "on_llm_end",
  run_id: LLM_RUN_ID,
  timestamp: T1,
  response: { llm_output: { token_usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } } },
};
export const LLM_END_NEW_TOKEN_FORMAT: LangChainCallbackEvent = {
  type: "on_llm_end",
  run_id: LLM_RUN_ID,
  timestamp: T1,
  response: { usage_metadata: { input_tokens: 130, output_tokens: 90, total_tokens: 220 } },
};
export const LLM_END_NO_TOKEN_DATA: LangChainCallbackEvent = { type: "on_llm_end", run_id: LLM_RUN_ID, timestamp: T1, response: {} };
export const LLM_ERROR: LangChainCallbackEvent = { type: "on_llm_error", run_id: LLM_RUN_ID, timestamp: T1, error: { message: "rate limit exceeded for patient SSN 123-45-6789 request", name: "RateLimitError" } };

export const TOOL_START: LangChainCallbackEvent = { type: "on_tool_start", run_id: TOOL_RUN_ID, timestamp: T0, serialized: { name: "web_search" }, input_str: "latest weather" };
export const TOOL_END: LangChainCallbackEvent = { type: "on_tool_end", run_id: TOOL_RUN_ID, timestamp: T1, output: "sunny, 72F", name: "web_search" };
export const TOOL_ERROR: LangChainCallbackEvent = { type: "on_tool_error", run_id: TOOL_RUN_ID, timestamp: T1, error: { message: "tool timed out", name: "ToolTimeoutError" }, name: "web_search" };

export const RETRIEVER_START: LangChainCallbackEvent = { type: "on_retriever_start", run_id: RETRIEVER_RUN_ID, timestamp: T0, serialized: { name: "VectorStoreRetriever" }, query: "refund policy" };
export const RETRIEVER_END: LangChainCallbackEvent = { type: "on_retriever_end", run_id: RETRIEVER_RUN_ID, timestamp: T1, documents: [{ id: 1 }, { id: 2 }, { id: 3 }] };

export const MALFORMED_ENVELOPE = { agent_id: randomUUID() }; // missing tenant_id/adapter_version/event entirely
