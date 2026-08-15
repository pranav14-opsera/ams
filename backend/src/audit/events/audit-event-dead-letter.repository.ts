import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { CanonicalAuditEvent } from "./canonical-audit-event";

@Injectable()
export class AuditEventDeadLetterRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(client: Pool | PoolClient | undefined, event: CanonicalAuditEvent, errorMessage: string, retryCount = 0): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO audit_events_dlq (tenant_id, event_id, payload, error_message, retry_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.tenant_id, event.event_id, JSON.stringify(event), errorMessage, retryCount],
    );
  }

  async findByTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<Array<{ id: string; event_id: string; error_message: string; retry_count: number }>> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      "SELECT id, event_id, error_message, retry_count FROM audit_events_dlq WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId],
    );
    return result.rows;
  }
}
