import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

export interface AdapterHealthCheckRow {
  id: string;
  adapter_type: string;
  check_timestamp: Date;
  status: "healthy" | "unhealthy";
  response_time_ms: number | null;
  error_details: string | null;
}

@Injectable()
export class AdapterHealthCheckRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(
    adapterType: string,
    status: "healthy" | "unhealthy",
    responseTimeMs: number | null,
    errorDetails: string | null,
    client?: Pool | PoolClient,
  ): Promise<AdapterHealthCheckRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<AdapterHealthCheckRow>(
      `INSERT INTO adapter_health_checks (adapter_type, status, response_time_ms, error_details)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [adapterType, status, responseTimeMs, errorDetails],
    );
    return result.rows[0];
  }

  /** Most recent checks first — AC: "recent health check history (last 10 checks)". */
  async findRecentByType(adapterType: string, limit = 10, client?: Pool | PoolClient): Promise<AdapterHealthCheckRow[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<AdapterHealthCheckRow>(
      "SELECT * FROM adapter_health_checks WHERE adapter_type = $1 ORDER BY check_timestamp DESC LIMIT $2",
      [adapterType, limit],
    );
    return result.rows;
  }

  /** AC: "automated cleanup of adapter_health_checks records older than the configurable retention period (default 30 days)". */
  async deleteOlderThan(retentionDays: number, client?: Pool | PoolClient): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query("DELETE FROM adapter_health_checks WHERE check_timestamp < now() - ($1 || ' days')::interval", [retentionDays]);
    return result.rowCount ?? 0;
  }
}
