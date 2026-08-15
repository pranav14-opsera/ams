import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { AuditEventInput } from "../tenants/ports/audit-service.port";

export interface InsertedAuditEvent {
  id: string;
  recordHash: string;
  occurredAt: Date;
}

export interface AuditChainVerification {
  valid: boolean;
  firstBrokenId: string | null;
  firstBrokenOccurredAt: Date | null;
  detail: string;
}

const RETRYABLE_POSTGRES_ERROR_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);
const MAX_INSERT_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 50;

function isRetryablePostgresError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && RETRYABLE_POSTGRES_ERROR_CODES.has((err as { code: string }).code);
}

/**
 * WO-045: the foundational append-only audit store's application-layer
 * surface — `audit_events` itself (append-only via REVOKE UPDATE/DELETE,
 * SHA-256 per-tenant hash chain via the `audit_events_hash_chain()`
 * trigger, RLS with FORCE, monthly partitioning) predates this class
 * entirely (migration 005/006/008). This repository doesn't re-implement
 * any of that — it's the typed, retry-aware entry point other services
 * use to write and independently VERIFY that chain, wrapping the two
 * pieces migration 038 added: per-tenant advisory-lock serialization
 * (inside the trigger itself) and `verify_audit_chain()`.
 *
 * This coexists with `AuditServicePort`/`PostgresAuditService`
 * (tenants/ports) rather than replacing them — that port is already
 * injected by 10+ existing services as the generic "record an audit
 * event" abstraction. Introducing hash-chain verification and insert
 * retry logic into that shared, widely-depended-on interface would risk
 * regressing everything already using it; this is new, additive surface
 * for the specific verification/foundation concerns this WO asks for.
 */
@Injectable()
export class AuditStoreRepository {
  private readonly logger = new Logger(AuditStoreRepository.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Inserts one audit event. The advisory lock inside
   * `audit_events_hash_chain()` (migration 038) already serializes
   * concurrent inserts for the SAME tenant, so a genuine chain race
   * shouldn't occur — this retry is defense-in-depth against a
   * transient serialization failure or deadlock (e.g. lock ordering
   * with an unrelated concurrent statement), not the primary
   * correctness mechanism.
   */
  async insertAuditEvent(event: AuditEventInput, client?: Pool | PoolClient, occurredAt?: Date): Promise<InsertedAuditEvent> {
    const executor = client ?? this.pool;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt++) {
      try {
        const result = await executor.query(
          `INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, details, data_classification, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'internal'), COALESCE($8, now()))
           RETURNING id, record_hash, occurred_at`,
          [event.tenantId, event.actorId, event.action, event.resourceType, event.resourceId, JSON.stringify(event.details), event.dataClassification ?? null, occurredAt ?? null],
        );
        const row = result.rows[0];
        return { id: row.id, recordHash: row.record_hash, occurredAt: row.occurred_at };
      } catch (err) {
        lastErr = err;
        if (!isRetryablePostgresError(err) || attempt === MAX_INSERT_ATTEMPTS) throw err;
        this.logger.warn(`audit event insert attempt ${attempt} failed with a retryable error, retrying: ${err instanceof Error ? err.message : err}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
      }
    }

    throw lastErr;
  }

  /** The most recent record_hash for a tenant — the chain's current tip, or null if the tenant has no audit events yet (genesis). */
  async getLastHash(tenantId: string, client?: Pool | PoolClient): Promise<string | null> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT record_hash FROM audit_events WHERE tenant_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1", [tenantId]);
    return result.rows[0]?.record_hash ?? null;
  }

  /** Independently recomputes and verifies the hash chain for a tenant across a time range, returning the first broken link if tampering is detected. */
  async verifyChain(tenantId: string, startTime: Date, endTime: Date, client?: Pool | PoolClient): Promise<AuditChainVerification> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT * FROM verify_audit_chain($1, $2, $3)", [tenantId, startTime.toISOString(), endTime.toISOString()]);
    const row = result.rows[0];
    return { valid: row.valid, firstBrokenId: row.first_broken_id, firstBrokenOccurredAt: row.first_broken_occurred_at, detail: row.detail };
  }
}
