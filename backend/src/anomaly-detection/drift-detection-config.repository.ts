import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { DriftDetectionConfig, SensitivityLevel } from "./anomaly-detection.types";

interface DriftDetectionConfigRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  sensitivity: SensitivityLevel;
  enabled: boolean;
}

function toDomain(row: DriftDetectionConfigRow): DriftDetectionConfig {
  return { id: row.id, tenantId: row.tenant_id, agentId: row.agent_id, sensitivity: row.sensitivity, enabled: row.enabled };
}

@Injectable()
export class DriftDetectionConfigRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Upsert — creating a config for an agent that already has one just updates its sensitivity/enabled, rather than erroring (this WO's own AC treats "configure sensitivity" as idempotent, not create-once). */
  async upsert(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sensitivity: SensitivityLevel, enabled: boolean): Promise<DriftDetectionConfig> {
    const executor = client ?? this.pool;
    const result = await executor.query<DriftDetectionConfigRow>(
      `INSERT INTO drift_detection_configs (tenant_id, agent_id, sensitivity, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET sensitivity = $3, enabled = $4, updated_at = now()
       RETURNING *`,
      [tenantId, agentId, sensitivity, enabled],
    );
    return toDomain(result.rows[0]);
  }

  async findByAgentId(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<DriftDetectionConfig | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<DriftDetectionConfigRow>("SELECT * FROM drift_detection_configs WHERE tenant_id = $1 AND agent_id = $2", [tenantId, agentId]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async findAllEnabledForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<DriftDetectionConfig[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<DriftDetectionConfigRow>("SELECT * FROM drift_detection_configs WHERE tenant_id = $1 AND enabled = true", [tenantId]);
    return result.rows.map(toDomain);
  }

  /** Same "cheaper than iterating every tenant" pattern as WO-059's AlertThresholdRepository.findDistinctTenantIds. */
  async findDistinctTenantIds(client?: Pool | PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM drift_detection_configs WHERE enabled = true");
    return result.rows.map((row) => row.tenant_id);
  }
}
