import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { DataCategory } from "./retention-policy.constants";

export interface RetentionPolicy {
  tenantId: string;
  dataCategory: DataCategory;
  retentionDays: number;
  previousRetentionDays: number | null;
  policyChangedAt: Date | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toPolicy(row: any): RetentionPolicy {
  return {
    tenantId: row.tenant_id,
    dataCategory: row.data_category,
    retentionDays: row.retention_days,
    previousRetentionDays: row.previous_retention_days,
    policyChangedAt: row.policy_changed_at,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class RetentionPolicyRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByTenant(tenantId: string, client?: Pool | PoolClient): Promise<RetentionPolicy[]> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT * FROM retention_policies WHERE tenant_id = $1 ORDER BY data_category", [tenantId]);
    return result.rows.map(toPolicy);
  }

  async findOne(tenantId: string, dataCategory: DataCategory, client?: Pool | PoolClient): Promise<RetentionPolicy | null> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT * FROM retention_policies WHERE tenant_id = $1 AND data_category = $2", [tenantId, dataCategory]);
    return result.rows.length > 0 ? toPolicy(result.rows[0]) : null;
  }

  /** Upserts a policy, recording the outgoing retention_days as previous_retention_days (with a fresh policy_changed_at) whenever the value actually changes — the grace-period mechanism's own bookkeeping. */
  async upsert(input: { tenantId: string; dataCategory: DataCategory; retentionDays: number; updatedBy: string | null }, client?: Pool | PoolClient): Promise<RetentionPolicy> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      `INSERT INTO retention_policies (tenant_id, data_category, retention_days, previous_retention_days, policy_changed_at, updated_by)
       VALUES ($1, $2, $3, NULL, NULL, $4)
       ON CONFLICT (tenant_id, data_category) DO UPDATE SET
         previous_retention_days = CASE WHEN retention_policies.retention_days <> EXCLUDED.retention_days THEN retention_policies.retention_days ELSE retention_policies.previous_retention_days END,
         policy_changed_at = CASE WHEN retention_policies.retention_days <> EXCLUDED.retention_days THEN now() ELSE retention_policies.policy_changed_at END,
         retention_days = EXCLUDED.retention_days,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [input.tenantId, input.dataCategory, input.retentionDays, input.updatedBy],
    );
    return toPolicy(result.rows[0]);
  }

}
