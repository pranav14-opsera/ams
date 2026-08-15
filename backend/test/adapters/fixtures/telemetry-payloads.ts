import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { CanonicalTelemetryEvent } from "../../../src/adapters/schemas/canonical-telemetry";

/**
 * Sample raw + canonical telemetry payloads for all 4 documented
 * framework types, each in a valid, an invalid (fails schema
 * validation), and a PHI-containing variant — this WO's own fixture
 * requirement. The "raw" shape here approximates what each framework's
 * real WO-035/036/037/038 adapter would receive on the wire; only the
 * canonical shape is authoritative for this WO's own pipeline (there is
 * no real translateTelemetry() per framework yet — that's each of those
 * WOs' own scope).
 */
function canonicalEvent(framework: CanonicalTelemetryEvent["framework_type"], overrides: Partial<CanonicalTelemetryEvent> = {}): CanonicalTelemetryEvent {
  return {
    event_id: randomUUID(),
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: "metric" as any,
    latency_ms: 100,
    error_rate: 0,
    token_consumption: 200,
    tool_call_success: true,
    tool_call_name: "example_tool",
    framework_type: framework,
    adapter_version: "1.0.0",
    raw_payload_hash: createHash("sha256").update(`${framework}-sample`).digest("hex"),
    metadata: {},
    ...overrides,
  };
}

export const LANGCHAIN_RAW_SAMPLE = {
  run_id: "lc-run-123",
  chain_type: "AgentExecutor",
  latency: 240,
  tokens: { total: 512 },
  tool: { name: "web_search", success: true },
};
export const LANGCHAIN_VALID_CANONICAL = canonicalEvent("langchain", { latency_ms: 240, token_consumption: 512, tool_call_name: "web_search" });
export const LANGCHAIN_INVALID_CANONICAL = { ...canonicalEvent("langchain"), latency_ms: "fast" }; // wrong type
export const LANGCHAIN_PHI_CANONICAL = canonicalEvent("langchain", { metadata: { patient_ssn: "111-22-3333" } });

export const CREWAI_RAW_SAMPLE = {
  crew_run_id: "crew-456",
  agent_role: "researcher",
  duration_ms: 310,
  task_success: false,
};
export const CREWAI_VALID_CANONICAL = canonicalEvent("crewai", { latency_ms: 310, tool_call_success: false, event_type: "error" as any });
export const CREWAI_INVALID_CANONICAL = (() => {
  const event = canonicalEvent("crewai") as any;
  delete event.agent_id; // missing required field
  return event;
})();
export const CREWAI_PHI_CANONICAL = canonicalEvent("crewai", { metadata: { patient_name: "Jane Doe" } });

export const AUTOGEN_RAW_SAMPLE = {
  conversation_id: "ag-789",
  round: 3,
  message_tokens: 88,
};
export const AUTOGEN_VALID_CANONICAL = canonicalEvent("autogen", { token_consumption: 88, event_type: "trace" as any });
export const AUTOGEN_INVALID_CANONICAL = { ...canonicalEvent("autogen"), framework_type: "not_a_real_framework" as any };
export const AUTOGEN_PHI_CANONICAL = canonicalEvent("autogen", { metadata: { date_of_birth: "1990-01-15" } });

export const GENERIC_REST_RAW_SAMPLE = {
  status: "ok",
  response_time_ms: 45,
};
export const GENERIC_REST_VALID_CANONICAL = canonicalEvent("generic_rest", { latency_ms: 45, event_type: "heartbeat" as any, tool_call_name: null, tool_call_success: null });
export const GENERIC_REST_INVALID_CANONICAL = { ...canonicalEvent("generic_rest"), extra_undocumented_field: "should not be allowed" };
export const GENERIC_REST_PHI_CANONICAL = canonicalEvent("generic_rest", { metadata: { medical_record_number: "MRN0012345" } });
