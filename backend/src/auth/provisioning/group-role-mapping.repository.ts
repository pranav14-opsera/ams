import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";

export type PlatformRole = "platform_admin" | "compliance_officer" | "finance_manager" | "team_lead" | "agent_operator";

export interface GroupRoleMapping {
  id: string;
  tenantId: string;
  idpGroup: string;
  platformRole: PlatformRole;
  priority: number;
}

function toDomain(row: any): GroupRoleMapping {
  return { id: row.id, tenantId: row.tenant_id, idpGroup: row.idp_group, platformRole: row.platform_role, priority: row.priority };
}

@Injectable()
export class GroupRoleMappingRepository {
  async list(pool: Pool, tenantId: string): Promise<GroupRoleMapping[]> {
    const result = await pool.query("SELECT * FROM group_role_mappings WHERE tenant_id = $1 ORDER BY priority ASC, idp_group ASC", [tenantId]);
    return result.rows.map(toDomain);
  }

  async upsert(pool: Pool, tenantId: string, idpGroup: string, platformRole: PlatformRole, priority: number): Promise<GroupRoleMapping> {
    const result = await pool.query(
      `INSERT INTO group_role_mappings (tenant_id, idp_group, platform_role, priority)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, idp_group) DO UPDATE SET platform_role = $3, priority = $4, updated_at = now()
       RETURNING *`,
      [tenantId, idpGroup, platformRole, priority],
    );
    return toDomain(result.rows[0]);
  }

  async delete(pool: Pool, tenantId: string, id: string): Promise<boolean> {
    const result = await pool.query("DELETE FROM group_role_mappings WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Lowest `priority` value among the caller's groups wins; null when none of the groups have a mapping (deny-by-default). */
  async resolveRole(pool: Pool, tenantId: string, groups: string[]): Promise<PlatformRole | null> {
    if (groups.length === 0) return null;
    const result = await pool.query<{ platform_role: PlatformRole }>(
      "SELECT platform_role FROM group_role_mappings WHERE tenant_id = $1 AND idp_group = ANY($2) ORDER BY priority ASC LIMIT 1",
      [tenantId, groups],
    );
    return result.rows[0]?.platform_role ?? null;
  }
}
