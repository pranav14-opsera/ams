// The canonical shape every framework adapter's translateTelemetry()
// must produce — core platform logic (the pipeline, storage, Kafka
// consumers) only ever sees this shape, never a framework-specific one.
// Mirrored 1:1 by canonical-telemetry.schema.json (kept in sync
// manually; canonical-telemetry.schema.test.ts asserts every property
// here has a corresponding schema property, and vice versa).
export enum TelemetryEventType {
  HEARTBEAT = "heartbeat",
  METRIC = "metric",
  TRACE = "trace",
  ERROR = "error",
}

export const AGENT_FRAMEWORK_TYPES = ["langchain", "crewai", "autogen", "generic_rest"] as const;
export type AgentFrameworkType = (typeof AGENT_FRAMEWORK_TYPES)[number];

export interface CanonicalTelemetryEvent {
  event_id: string;
  agent_id: string;
  tenant_id: string;
  timestamp: string; // ISO 8601
  event_type: TelemetryEventType;
  latency_ms: number | null;
  error_rate: number | null;
  token_consumption: number | null;
  tool_call_success: boolean | null;
  tool_call_name: string | null;
  framework_type: AgentFrameworkType;
  adapter_version: string;
  // SHA-256 hex digest of the original raw adapter payload, computed by
  // the adapter's translateTelemetry() before any pipeline mutation
  // (enrichment/scrubbing) — lets a downstream consumer detect drift
  // between what the source framework actually emitted and what reached
  // Kafka, without having to retain the (possibly PHI-bearing) raw payload.
  raw_payload_hash: string;
  metadata: Record<string, unknown>;
}
