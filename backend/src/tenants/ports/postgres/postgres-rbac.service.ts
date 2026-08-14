import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../../common/database/database.module";
import { ALL_PLATFORM_ROLE_NAMES } from "../../../rbac/rbac.constants";
import type { RbacServicePort } from "../rbac-service.port";

@Injectable()
export class PostgresRbacService implements RbacServicePort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async applyDefaultPolicies(tenantId: string, client?: PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    // WO-023's canonical role_permissions matrix is the real source of
    // truth for what each role starts out able to do — copied in as this
    // tenant's OWN mutable rbac_policies row, not read live from
    // role_permissions on every token mint. That keeps a tenant free to
    // later diverge from the platform default (a future admin-facing
    // grant editor) without this canonical matrix moving underneath them.
    for (const role of ALL_PLATFORM_ROLE_NAMES) {
      await executor.query(
        `INSERT INTO rbac_policies (tenant_id, role, permissions)
         SELECT $1, $2, COALESCE(jsonb_agg(permission_name), '[]'::jsonb)
         FROM role_permissions WHERE role_name = $2
         ON CONFLICT (tenant_id, role) DO NOTHING`,
        [tenantId, role],
      );
    }
  }

  async getPermissionsForRoles(tenantId: string, roles: string[]): Promise<string[]> {
    if (roles.length === 0) return [];
    const result = await this.pool.query<{ permission: string }>(
      `SELECT jsonb_array_elements_text(permissions) AS permission
       FROM rbac_policies WHERE tenant_id = $1 AND role = ANY($2)`,
      [tenantId, roles],
    );
    return [...new Set(result.rows.map((r) => r.permission))];
  }
}
