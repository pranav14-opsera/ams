import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { CanonicalTelemetryEvent } from "../adapters/schemas/canonical-telemetry";

@Injectable()
export class PhiQuarantineRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(client: Pool | PoolClient | undefined, event: CanonicalTelemetryEvent, reason: string): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO phi_quarantine_events (tenant_id, agent_id, event_id, payload, quarantine_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.tenant_id, event.agent_id, event.event_id, JSON.stringify(event), reason],
    );
  }

  async findByTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<Array<{ id: string; event_id: string; quarantine_reason: string; reviewed: boolean }>> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      "SELECT id, event_id, quarantine_reason, reviewed FROM phi_quarantine_events WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId],
    );
    return result.rows;
  }
}
