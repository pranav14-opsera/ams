import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";

export interface RoleDefinition {
  name: string;
  displayName: string;
  description: string;
  scope: "organization" | "team" | "personal";
  isSystem: boolean;
  permissions: string[];
}

export interface PermissionDefinition {
  name: string;
  displayName: string;
  description: string;
  featureArea: string;
  resourceType: string;
  action: string;
}

export interface PermissionsByFeatureArea {
  featureArea: string;
  permissions: PermissionDefinition[];
}

function toRoleRow(row: any): Omit<RoleDefinition, "permissions"> {
  return { name: row.name, displayName: row.display_name, description: row.description, scope: row.scope, isSystem: row.is_system };
}

function toPermissionRow(row: any): PermissionDefinition {
  return { name: row.name, displayName: row.display_name, description: row.description, featureArea: row.feature_area, resourceType: row.resource_type, action: row.action };
}

@Injectable()
export class RbacDefinitionService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Every canonical role with its full permission-name list, for stakeholder/UI rendering of "what does this role mean". */
  async getRoles(): Promise<RoleDefinition[]> {
    const roles = await this.pool.query("SELECT name, display_name, description, scope, is_system FROM roles ORDER BY name");
    const permissions = await this.pool.query<{ role_name: string; permission_name: string }>(
      "SELECT role_name, permission_name FROM role_permissions ORDER BY role_name, permission_name",
    );

    const permissionsByRole = new Map<string, string[]>();
    for (const row of permissions.rows) {
      const existing = permissionsByRole.get(row.role_name) ?? [];
      existing.push(row.permission_name);
      permissionsByRole.set(row.role_name, existing);
    }

    return roles.rows.map((row) => ({ ...toRoleRow(row), permissions: permissionsByRole.get(row.name) ?? [] }));
  }

  /** Every permission, grouped by feature area — matches how the docs/rbac-permission-matrix.md table is organized. */
  async getPermissions(): Promise<PermissionsByFeatureArea[]> {
    const result = await this.pool.query(
      "SELECT name, display_name, description, feature_area, resource_type, action FROM permissions ORDER BY feature_area, name",
    );

    const grouped = new Map<string, PermissionDefinition[]>();
    for (const row of result.rows) {
      const permission = toPermissionRow(row);
      const existing = grouped.get(permission.featureArea) ?? [];
      existing.push(permission);
      grouped.set(permission.featureArea, existing);
    }

    return [...grouped.entries()].map(([featureArea, perms]) => ({ featureArea, permissions: perms }));
  }

  async getRolePermissions(roleName: string): Promise<string[]> {
    const result = await this.pool.query<{ permission_name: string }>(
      "SELECT permission_name FROM role_permissions WHERE role_name = $1 ORDER BY permission_name",
      [roleName],
    );
    return result.rows.map((r) => r.permission_name);
  }

  async hasPermission(roleName: string, permissionName: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM role_permissions WHERE role_name = $1 AND permission_name = $2", [roleName, permissionName]);
    return (result.rowCount ?? 0) > 0;
  }
}
