import type { AgentFrameworkType, CanonicalTelemetryEvent, TelemetryEventType } from "../schemas/canonical-telemetry";

export interface ConnectionValidationResult {
  valid: boolean;
  reason?: string;
}

export interface HealthProbeResult {
  healthy: boolean;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface AdapterMetadata {
  frameworkType: AgentFrameworkType;
  adapterVersion: string;
  supportedEventTypes: TelemetryEventType[];
}

/**
 * The contract every framework-specific adapter (LangChain — WO-035,
 * generic REST — WO-036, CrewAI — WO-037, AutoGen — WO-038) implements.
 * Core platform logic (ingestion controller, telemetry pipeline, Kafka
 * consumers) depends only on this interface, never on a specific
 * framework's wire format — that isolation is this WO's entire point.
 */
export interface IAgentAdapter {
  /** Verifies the adapter can actually reach/authenticate against the framework instance described by `config` (called at agent registration time, before any telemetry is trusted). */
  validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult>;

  /** Translates one framework-native raw event into the canonical shape. Throws on a malformed/unrecognized raw event — the caller (ingestion pipeline) is responsible for turning that into an HTTP 400. */
  translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent;

  /** Active health check against the underlying framework instance (distinct from a passive heartbeat telemetry event). */
  getHealthProbe(): Promise<HealthProbeResult>;

  getAdapterMetadata(): AdapterMetadata;
}
