import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { ChannelType, DeliveryStatus } from "./alert-delivery.types";

export interface AlertDeliveryLogRow {
  id: string;
  tenant_id: string;
  alert_event_id: string;
  channel_type: ChannelType;
  status: DeliveryStatus;
  attempt_number: number;
  latency_ms: number | null;
  error_message: string | null;
  created_at: Date;
}

/** Immutable — INSERT and SELECT only, matching migration 047's own doc comment. */
@Injectable()
export class AlertDeliveryLogRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    alertEventId: string,
    fields: { channelType: ChannelType; status: DeliveryStatus; attemptNumber: number; latencyMs: number | null; errorMessage: string | null },
  ): Promise<AlertDeliveryLogRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<AlertDeliveryLogRow>(
      `INSERT INTO alert_delivery_log (tenant_id, alert_event_id, channel_type, status, attempt_number, latency_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenantId, alertEventId, fields.channelType, fields.status, fields.attemptNumber, fields.latencyMs, fields.errorMessage],
    );
    return result.rows[0];
  }

  /** Idempotency check: has this alert event already been processed for delivery at all? */
  async existsForAlertEvent(client: Pool | PoolClient | undefined, tenantId: string, alertEventId: string): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT 1 FROM alert_delivery_log WHERE tenant_id = $1 AND alert_event_id = $2 LIMIT 1", [tenantId, alertEventId]);
    return (result.rowCount ?? 0) > 0;
  }

  async findByAlertEvent(client: Pool | PoolClient | undefined, tenantId: string, alertEventId: string): Promise<AlertDeliveryLogRow[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<AlertDeliveryLogRow>("SELECT * FROM alert_delivery_log WHERE tenant_id = $1 AND alert_event_id = $2 ORDER BY created_at ASC", [tenantId, alertEventId]);
    return result.rows;
  }
}
