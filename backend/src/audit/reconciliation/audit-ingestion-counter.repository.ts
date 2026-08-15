import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * WO-048's "source system" substitute (see migration 041's own header
 * comment for the full rationale) — an ingestion-attempt counter,
 * incremented once per canonical audit event AuditEventConsumerPipelineService
 * is ever invoked with, regardless of outcome.
 */
@Injectable()
export class AuditIngestionCounterRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async increment(tenantId: string, occurredAt: Date, client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO audit_ingestion_counters (tenant_id, day, attempted_count) VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, day) DO UPDATE SET attempted_count = audit_ingestion_counters.attempted_count + 1`,
      [tenantId, dayKey(occurredAt)],
    );
  }

  async sumForRange(tenantId: string, startTime: Date, endTime: Date, client?: Pool | PoolClient): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      "SELECT coalesce(sum(attempted_count), 0)::bigint AS total FROM audit_ingestion_counters WHERE tenant_id = $1 AND day >= $2 AND day <= $3",
      [tenantId, dayKey(startTime), dayKey(endTime)],
    );
    return Number(result.rows[0].total);
  }
}
