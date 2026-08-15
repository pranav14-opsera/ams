import type { CanonicalAuditEvent } from "./canonical-audit-event";

export const AUDIT_EVENT_PUBLISHER = "AUDIT_EVENT_PUBLISHER";

export interface AuditEventPublisherPort {
  /** Publishes one canonical audit event, partitioned by tenant_id. Throws on failure — the caller (AuditEventConsumerPipelineService) is responsible for the DLQ fallback. */
  publish(event: CanonicalAuditEvent): Promise<void>;
}
