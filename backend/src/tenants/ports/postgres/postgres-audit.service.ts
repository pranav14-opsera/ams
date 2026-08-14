import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../../common/database/database.module";
import type { AuditEventInput, AuditServicePort } from "../audit-service.port";

@Injectable()
export class PostgresAuditService implements AuditServicePort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async recordEvent(event: AuditEventInput, client?: PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    // record_hash is computed by the audit_events_hash_chain() trigger
    // (database/migrations/005_create_audit_events.sql) — not set here.
    // data_classification: COALESCE keeps the column's own DEFAULT
    // ('internal') for every existing call site that doesn't pass one,
    // rather than forcing every caller in this codebase to adopt
    // WO-016's tagger in the same change.
    await executor.query(
      `INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, details, data_classification)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'internal'))`,
      [
        event.tenantId,
        event.actorId,
        event.action,
        event.resourceType,
        event.resourceId,
        JSON.stringify(event.details),
        event.dataClassification ?? null,
      ],
    );
  }
}
