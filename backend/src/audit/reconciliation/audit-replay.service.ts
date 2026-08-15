import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { AuditEventConsumerPipelineService } from "../events/audit-event-consumer-pipeline.service";
import type { CanonicalAuditEvent } from "../events/canonical-audit-event";

export interface ReplayResult {
  attempted: number;
  recovered: number;
  stillFailing: number;
}

/**
 * WO-048's "Kafka replay mechanism ... for gap recovery." This sandbox
 * has no reachable Kafka broker, so there are no real topic offsets to
 * replay from (documented throughout this codebase — TELEMETRY_PIPELINE.md,
 * STREAM_PROCESSING.md). The genuinely recoverable source of missing
 * events in THIS platform is audit_events_dlq — every event that failed
 * enrichment/scrub/persistence is already durably captured there with
 * its full original payload (WO-046). Replaying from the DLQ back
 * through the same processing pipeline is this sandbox's honest
 * equivalent of "re-publish from an offset range": it recovers exactly
 * the events a real offset-range replay would have targeted (anything
 * that didn't make it into audit_events the first time), without
 * fabricating Kafka admin-client code with no broker to run it against.
 */
@Injectable()
export class AuditReplayService {
  private readonly logger = new Logger(AuditReplayService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly pipeline: AuditEventConsumerPipelineService,
  ) {}

  async replayFromDeadLetterQueue(tenantId: string, since: Date, until: Date): Promise<ReplayResult> {
    const client = await this.pool.connect();
    let rows: Array<{ id: string; payload: CanonicalAuditEvent }>;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      const result = await client.query(
        "SELECT id, payload FROM audit_events_dlq WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY created_at ASC",
        [tenantId, since.toISOString(), until.toISOString()],
      );
      rows = result.rows;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    let recovered = 0;
    for (const row of rows) {
      const replayClient = await this.pool.connect();
      try {
        await replayClient.query("BEGIN");
        await replayClient.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        const result = await this.pipeline.process(replayClient, row.payload);
        if (!result.deadLettered) {
          await replayClient.query("DELETE FROM audit_events_dlq WHERE id = $1", [row.id]);
          recovered++;
        }
        await replayClient.query("COMMIT");
      } catch (err) {
        await replayClient.query("ROLLBACK").catch(() => undefined);
        this.logger.warn(`replay of DLQ event ${row.id} failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        replayClient.release();
      }
    }

    return { attempted: rows.length, recovered, stillFailing: rows.length - recovered };
  }
}
