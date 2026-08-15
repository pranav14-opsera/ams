// LangChain's own callback event shapes — deliberately loose/partial
// typing (most fields optional) since real LangChain instrumentation
// varies between the 0.2.x and 0.3.x callback formats this adapter must
// both support (this WO's own implementation_steps).

export interface LangChainTokenUsageLegacy {
  // 0.2.x-era shape: llm_output.token_usage.{prompt,completion,total}_tokens
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface LangChainUsageMetadata {
  // 0.3.x-era shape: response.usage_metadata.{input,output,total}_tokens
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface LangChainCallbackBase {
  run_id: string;
  parent_run_id?: string;
  timestamp: string; // ISO 8601
}

export interface LangChainLlmStartEvent extends LangChainCallbackBase {
  type: "on_llm_start";
  serialized?: { name?: string };
  prompts?: string[];
}

export interface LangChainLlmEndEvent extends LangChainCallbackBase {
  type: "on_llm_end";
  response?: {
    llm_output?: { token_usage?: LangChainTokenUsageLegacy };
    usage_metadata?: LangChainUsageMetadata;
  };
}

export interface LangChainLlmErrorEvent extends LangChainCallbackBase {
  type: "on_llm_error";
  error: { message: string; name?: string };
}

export interface LangChainToolStartEvent extends LangChainCallbackBase {
  type: "on_tool_start";
  serialized?: { name?: string };
  input_str?: string;
}

export interface LangChainToolEndEvent extends LangChainCallbackBase {
  type: "on_tool_end";
  output?: string;
  name?: string;
}

export interface LangChainToolErrorEvent extends LangChainCallbackBase {
  type: "on_tool_error";
  error: { message: string; name?: string };
  name?: string;
}

export interface LangChainChainStartEvent extends LangChainCallbackBase {
  type: "on_chain_start";
  serialized?: { name?: string };
}

export interface LangChainChainEndEvent extends LangChainCallbackBase {
  type: "on_chain_end";
  outputs?: Record<string, unknown>;
}

export interface LangChainChainErrorEvent extends LangChainCallbackBase {
  type: "on_chain_error";
  error: { message: string; name?: string };
}

export interface LangChainRetrieverStartEvent extends LangChainCallbackBase {
  type: "on_retriever_start";
  serialized?: { name?: string };
  query?: string;
}

export interface LangChainRetrieverEndEvent extends LangChainCallbackBase {
  type: "on_retriever_end";
  documents?: unknown[];
}

export type LangChainCallbackEvent =
  | LangChainLlmStartEvent
  | LangChainLlmEndEvent
  | LangChainLlmErrorEvent
  | LangChainToolStartEvent
  | LangChainToolEndEvent
  | LangChainToolErrorEvent
  | LangChainChainStartEvent
  | LangChainChainEndEvent
  | LangChainChainErrorEvent
  | LangChainRetrieverStartEvent
  | LangChainRetrieverEndEvent;

/**
 * What actually arrives at POST /api/v1/adapters/langchain/telemetry: a
 * LangChain callback event doesn't know anything about tenants or
 * agents (that's platform-specific context, not a LangChain concept) —
 * the client-side SDK snippet wraps it in this envelope, which is what
 * LangChainAdapter.translateTelemetry() actually receives as `rawEvent`.
 */
export interface LangChainTelemetryEnvelope {
  agent_id: string;
  tenant_id: string;
  adapter_version: string;
  event: LangChainCallbackEvent;
}
