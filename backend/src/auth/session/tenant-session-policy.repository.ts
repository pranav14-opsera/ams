import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

export interface TenantSessionPolicy {
  tenantId: string;
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
}

// Platform defaults, applied whenever a tenant has never configured its
// own policy — matches this table's own column DEFAULTs (migration 019),
// duplicated here so callers can get a policy without a row existing yet
// (no INSERT-on-first-read needed just to answer "what's the timeout").
export const DEFAULT_SESSION_POLICY: Omit<TenantSessionPolicy, "tenantId"> = {
  idleTimeoutSeconds: 1800,
  absoluteTimeoutSeconds: 28800,
};

interface Row {
  tenant_id: string;
  idle_timeout_seconds: number;
  absolute_timeout_seconds: number;
}

@Injectable()
export class TenantSessionPolicyRepository {
  async findByTenantId(clientOrPool: PoolClient | Pool, tenantId: string): Promise<TenantSessionPolicy | null> {
    const result = await clientOrPool.query<Row>("SELECT * FROM tenant_session_policies WHERE tenant_id = $1", [tenantId]);
    if (!result.rows[0]) return null;
    return { tenantId: result.rows[0].tenant_id, idleTimeoutSeconds: result.rows[0].idle_timeout_seconds, absoluteTimeoutSeconds: result.rows[0].absolute_timeout_seconds };
  }

  async upsert(clientOrPool: PoolClient | Pool, tenantId: string, idleTimeoutSeconds: number, absoluteTimeoutSeconds: number): Promise<TenantSessionPolicy> {
    const result = await clientOrPool.query<Row>(
      `INSERT INTO tenant_session_policies (tenant_id, idle_timeout_seconds, absolute_timeout_seconds)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET
         idle_timeout_seconds = EXCLUDED.idle_timeout_seconds,
         absolute_timeout_seconds = EXCLUDED.absolute_timeout_seconds,
         updated_at = now()
       RETURNING *`,
      [tenantId, idleTimeoutSeconds, absoluteTimeoutSeconds],
    );
    const row = result.rows[0];
    return { tenantId: row.tenant_id, idleTimeoutSeconds: row.idle_timeout_seconds, absoluteTimeoutSeconds: row.absolute_timeout_seconds };
  }
}
