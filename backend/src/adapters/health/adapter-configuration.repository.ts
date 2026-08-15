import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { AgentFrameworkType } from "../schemas/canonical-telemetry";

export type AdapterHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface AdapterConfigurationRow {
  adapter_type: AgentFrameworkType;
  adapter_version: string;
  supported_framework_versions: string;
  health_status: AdapterHealthStatus;
  consecutive_failures: number;
  last_health_check_at: Date | null;
  health_check_interval_seconds: number;
  created_at: Date;
  updated_at: Date;
}

// Platform-wide config (one row per framework_type, not per-tenant) — no
// tenant filter is expected here, same class of table as WO-023's global
// roles/permissions.
@Injectable()
export class AdapterConfigurationRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findAll(client?: Pool | PoolClient): Promise<AdapterConfigurationRow[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<AdapterConfigurationRow>("SELECT * FROM adapter_configurations ORDER BY adapter_type");
    return result.rows;
  }

  async findByType(adapterType: string, client?: Pool | PoolClient): Promise<AdapterConfigurationRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AdapterConfigurationRow>("SELECT * FROM adapter_configurations WHERE adapter_type = $1", [adapterType]);
    return result.rows[0] ?? null;
  }

  async updateHealth(
    adapterType: string,
    fields: { healthStatus: AdapterHealthStatus; consecutiveFailures: number; lastHealthCheckAt: Date },
    client?: Pool | PoolClient,
  ): Promise<AdapterConfigurationRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AdapterConfigurationRow>(
      `UPDATE adapter_configurations
       SET health_status = $1, consecutive_failures = $2, last_health_check_at = $3, updated_at = now()
       WHERE adapter_type = $4
       RETURNING *`,
      [fields.healthStatus, fields.consecutiveFailures, fields.lastHealthCheckAt, adapterType],
    );
    return result.rows[0] ?? null;
  }
}
