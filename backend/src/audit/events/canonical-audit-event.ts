// WO-046: the canonical shape the shared AuditEventProducer SDK (this
// file's own consumers) publishes, and the ONLY shape the enrichment
// pipeline consumes — mirrors WO-034's canonical-telemetry.ts pattern
// (a strict, additionalProperties:false schema every producing service
// must conform to, kept 1:1 in sync with canonical-audit-event.schema.json,
// asserted by canonical-audit-event.schema.test.ts).
export enum ActorType {
  USER = "user",
  SYSTEM = "system",
  SERVICE_ACCOUNT = "service_account",
  API_KEY = "api_key",
}

export const ACTOR_TYPES = Object.values(ActorType);

export interface CanonicalAuditEvent {
  /** Producer-generated, used for DLQ correlation and idempotency — not itself part of audit_events' own schema (that's `id`, server-assigned at insert time). */
  event_id: string;
  actor_id: string | null;
  actor_type: ActorType;
  tenant_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  /** Optional at the producer/SDK level — the enrichment pipeline validates/defaults this (RESTRICTED if missing or invalid) rather than requiring every producer to already know the platform's classification rules. */
  data_classification: string | null;
  ip_address: string | null;
  change_details: Record<string, unknown>;
  correlation_id: string | null;
  /** When the action actually happened, as observed by the producing service — distinct from audit_events.occurred_at, which the enrichment pipeline sets server-side at write time (see AUDIT_ENRICHMENT_PIPELINE.md for why these can legitimately differ). */
  occurred_at: string;
}
