import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

@Injectable()
export class CreditProcessedEventRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async isProcessed(client: Pool | PoolClient | undefined, eventId: string): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT 1 FROM credit_processed_events WHERE event_id = $1", [eventId]);
    return result.rows.length > 0;
  }

  /** Idempotent marker — ON CONFLICT DO NOTHING so re-marking an already-processed event (e.g. a retried batch) is a safe no-op, never a constraint-violation error. */
  async markProcessed(client: Pool | PoolClient | undefined, eventId: string, tenantId: string): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query("INSERT INTO credit_processed_events (event_id, tenant_id) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING", [eventId, tenantId]);
  }

  /** AC: "7-day TTL" — returns the number of rows purged, for the cleanup scheduler's own logging. */
  async purgeOlderThan(client: Pool | PoolClient | undefined, cutoff: Date): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query("DELETE FROM credit_processed_events WHERE processed_at < $1", [cutoff]);
    return result.rowCount ?? 0;
  }

  async countForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ count: string }>("SELECT count(*) AS count FROM credit_processed_events WHERE tenant_id = $1", [tenantId]);
    return Number(result.rows[0]?.count ?? 0);
  }
}
