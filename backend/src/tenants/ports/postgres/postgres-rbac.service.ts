import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../../common/database/database.module";
import type { RbacServicePort } from "../rbac-service.port";

// Matches rbac_policies' CHECK constraint exactly (database/migrations/010_create_rbac_abac_policies.sql).
const DEFAULT_ROLES = ["platform_admin", "compliance_officer", "finance_manager", "team_lead", "agent_operator"] as const;

@Injectable()
export class PostgresRbacService implements RbacServicePort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async applyDefaultPolicies(tenantId: string, client?: PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    // Empty permission set on purpose — WO-023 (Five-Tier Permission
    // Matrix) defines the actual per-role grants. This step's job is
    // just to guarantee every tenant has exactly one row per role to
    // update later, not to invent policy content here.
    for (const role of DEFAULT_ROLES) {
      await executor.query(
        `INSERT INTO rbac_policies (tenant_id, role, permissions)
         VALUES ($1, $2, '[]'::jsonb)
         ON CONFLICT (tenant_id, role) DO NOTHING`,
        [tenantId, role],
      );
    }
  }
}
