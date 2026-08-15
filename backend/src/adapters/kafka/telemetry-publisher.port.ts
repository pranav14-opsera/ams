import type { CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";

export const TELEMETRY_PUBLISHER = "TELEMETRY_PUBLISHER";

export interface TelemetryPublisherPort {
  /** Publishes one canonical event, partitioned by tenant_id. Throws on failure — the caller (TelemetryPipelineService) is responsible for the dead-letter fallback. */
  publish(event: CanonicalTelemetryEvent): Promise<void>;
}
