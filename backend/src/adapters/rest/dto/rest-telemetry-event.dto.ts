// Plain TypeScript shape (validated via ajv against
// rest-telemetry-event.schema.json in RestTelemetryValidatorService, not
// class-validator) — the AdaptersController receives the request body
// typed as `unknown` and hands it straight to the adapter, so there's no
// ValidationPipe stage a class-validator DTO would actually run through;
// ajv is what canonical-telemetry's own validation already uses, kept
// consistent here.
export interface RestTelemetryEventDto {
  event_id?: string;
  agent_id: string;
  tenant_id: string;
  timestamp?: string;
  event_type: "heartbeat" | "metric" | "trace" | "error";
  latency_ms?: number | null;
  /** Convenience alias for latency_ms. */
  duration_ms?: number | null;
  error_rate?: number | null;
  token_consumption?: number | null;
  /** Convenience alias for token_consumption. */
  tokens?: number | null;
  tool_call_success?: boolean | null;
  tool_call_name?: string | null;
  adapter_version?: string;
  raw_payload_hash?: string;
  metadata?: Record<string, unknown>;
}
