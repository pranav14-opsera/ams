import type { PoolClient } from "pg";

export const AUDIT_SERVICE = "AUDIT_SERVICE";

export interface AuditEventInput {
  tenantId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
}

export interface AuditServicePort {
  // `client` is optional and Postgres-specific: today audit_events lives
  // in the same database as tenants, so the saga passes its own
  // transaction client through to get real atomicity (this event commits
  // or rolls back with the rest of provisioning). A future real Audit
  // microservice implementation would ignore it — it'd be a network call
  // with its own durability guarantees, not a shared DB transaction.
  recordEvent(event: AuditEventInput, client?: PoolClient): Promise<void>;
}
