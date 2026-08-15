import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";

@Injectable()
export class TelemetryDeadLetterRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(client: Pool | PoolClient | undefined, event: CanonicalTelemetryEvent, publishError: string): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO telemetry_dead_letter_events (tenant_id, agent_id, event_id, payload, publish_error)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.tenant_id, event.agent_id, event.event_id, JSON.stringify(event), publishError],
    );
  }

  async findByTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<Array<{ id: string; event_id: string; publish_error: string }>> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT id, event_id, publish_error FROM telemetry_dead_letter_events WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
    return result.rows;
  }
}
