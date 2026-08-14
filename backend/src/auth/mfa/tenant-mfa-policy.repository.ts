import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

export interface TenantMfaPolicy {
  tenantId: string;
  restrictedElevationMinutes: number;
  requireMfaForInternal: boolean;
  requireMfaForPublic: boolean;
}

export const DEFAULT_MFA_POLICY: Omit<TenantMfaPolicy, "tenantId"> = {
  restrictedElevationMinutes: 60,
  requireMfaForInternal: false,
  requireMfaForPublic: false,
};

interface Row {
  tenant_id: string;
  restricted_elevation_minutes: number;
  require_mfa_for_internal: boolean;
  require_mfa_for_public: boolean;
}

function toPolicy(row: Row): TenantMfaPolicy {
  return {
    tenantId: row.tenant_id,
    restrictedElevationMinutes: row.restricted_elevation_minutes,
    requireMfaForInternal: row.require_mfa_for_internal,
    requireMfaForPublic: row.require_mfa_for_public,
  };
}

@Injectable()
export class TenantMfaPolicyRepository {
  async findByTenantId(clientOrPool: PoolClient | Pool, tenantId: string): Promise<TenantMfaPolicy | null> {
    const result = await clientOrPool.query<Row>("SELECT * FROM tenant_mfa_policies WHERE tenant_id = $1", [tenantId]);
    return result.rows[0] ? toPolicy(result.rows[0]) : null;
  }

  async upsert(clientOrPool: PoolClient | Pool, tenantId: string, patch: Omit<TenantMfaPolicy, "tenantId">): Promise<TenantMfaPolicy> {
    const result = await clientOrPool.query<Row>(
      `INSERT INTO tenant_mfa_policies (tenant_id, restricted_elevation_minutes, require_mfa_for_internal, require_mfa_for_public)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET
         restricted_elevation_minutes = EXCLUDED.restricted_elevation_minutes,
         require_mfa_for_internal = EXCLUDED.require_mfa_for_internal,
         require_mfa_for_public = EXCLUDED.require_mfa_for_public,
         updated_at = now()
       RETURNING *`,
      [tenantId, patch.restrictedElevationMinutes, patch.requireMfaForInternal, patch.requireMfaForPublic],
    );
    return toPolicy(result.rows[0]);
  }
}
