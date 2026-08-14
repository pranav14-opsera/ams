import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { RbacDefinitionService } from "../../src/rbac/rbac-definition.service";
import { ALL_PERMISSION_NAMES, ALL_PLATFORM_ROLE_NAMES, PermissionName, PlatformRoleName } from "../../src/rbac/rbac.constants";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

const ROLE_COLUMN_ORDER = [
  PlatformRoleName.PLATFORM_ADMIN,
  PlatformRoleName.TEAM_LEAD,
  PlatformRoleName.AGENT_OPERATOR,
  PlatformRoleName.FINANCE_MANAGER,
  PlatformRoleName.COMPLIANCE_OFFICER,
];

/** Parses the "## Permission Matrix" table in docs/rbac-permission-matrix.md into { permissionName -> Set<roleName> }. */
function parseDocMatrix(): Map<string, Set<string>> {
  const docPath = join(__dirname, "../../../docs/rbac-permission-matrix.md");
  const content = readFileSync(docPath, "utf8");
  const matrix = new Map<string, Set<string>>();

  for (const line of content.split("\n")) {
    if (!line.startsWith("| ") || !line.includes(":")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    const permissionName = cells[0];
    if (!/^[a-z_]+:[a-z_]+:[a-z_]+$/.test(permissionName)) continue;

    const roles = new Set<string>();
    ROLE_COLUMN_ORDER.forEach((role, index) => {
      if (cells[index + 1] === "✓") roles.add(role);
    });
    matrix.set(permissionName, roles);
  }

  return matrix;
}

async function fetchDbMatrix(pool: Pool): Promise<Map<string, Set<string>>> {
  const result = await pool.query<{ permission_name: string; role_name: string }>("SELECT permission_name, role_name FROM role_permissions");
  const matrix = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const existing = matrix.get(row.permission_name) ?? new Set<string>();
    existing.add(row.role_name);
    matrix.set(row.permission_name, existing);
  }
  return matrix;
}

test("docs/rbac-permission-matrix.md matches the seeded database exactly", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const docMatrix = parseDocMatrix();
    const dbMatrix = await fetchDbMatrix(pool);

    assert.deepEqual(new Set(docMatrix.keys()), new Set(ALL_PERMISSION_NAMES), "the doc must list exactly the permissions in rbac.constants.ts");
    assert.deepEqual(new Set(dbMatrix.keys()), new Set(ALL_PERMISSION_NAMES), "the database must have exactly the permissions in rbac.constants.ts");

    for (const permission of ALL_PERMISSION_NAMES) {
      assert.deepEqual(docMatrix.get(permission), dbMatrix.get(permission), `role assignment for ${permission} must match between the doc and the database`);
    }
  } finally {
    await pool.end();
  }
});

test("every one of the 5 canonical roles is seeded in the database", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const result = await pool.query<{ name: string }>("SELECT name FROM roles ORDER BY name");
    assert.deepEqual(new Set(result.rows.map((r) => r.name)), new Set(ALL_PLATFORM_ROLE_NAMES));
  } finally {
    await pool.end();
  }
});

test("all canonical permissions are seeded, at least 8 feature areas, at least 40 permissions", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const result = await pool.query<{ name: string; feature_area: string }>("SELECT name, feature_area FROM permissions");
    assert.deepEqual(new Set(result.rows.map((r) => r.name)), new Set(ALL_PERMISSION_NAMES));
    assert.ok(result.rows.length >= 40, "must have at least 40 permissions");
    assert.ok(new Set(result.rows.map((r) => r.feature_area)).size >= 8, "must cover at least 8 feature areas");
  } finally {
    await pool.end();
  }
});

test("every role has at least one permission, and every permission is assigned to at least one role", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const rolesWithNone = await pool.query(
      "SELECT r.name FROM roles r LEFT JOIN role_permissions rp ON rp.role_name = r.name WHERE rp.role_name IS NULL",
    );
    assert.equal(rolesWithNone.rows.length, 0, "no role may have zero permissions");

    const orphanedPermissions = await pool.query(
      "SELECT p.name FROM permissions p LEFT JOIN role_permissions rp ON rp.permission_name = p.name WHERE rp.role_name IS NULL",
    );
    assert.equal(orphanedPermissions.rows.length, 0, "no permission may be unassigned to every role");
  } finally {
    await pool.end();
  }
});

test("platform_admin does NOT hold finance-specific budget/overage permissions", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    assert.equal(await service.hasPermission(PlatformRoleName.PLATFORM_ADMIN, PermissionName.CREDIT_BUDGET_CONFIGURE), false);
    assert.equal(await service.hasPermission(PlatformRoleName.PLATFORM_ADMIN, PermissionName.CREDIT_OVERAGE_CAP_MANAGE), false);
  } finally {
    await pool.end();
  }
});

test("team_lead does NOT hold any organization-wide user_management or tenant_configuration permission", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    const permissions = await service.getRolePermissions(PlatformRoleName.TEAM_LEAD);
    assert.ok(!permissions.some((p) => p.startsWith("tenant_configuration:")), "team_lead must not manage org-wide tenant configuration");
    assert.ok(!permissions.some((p) => p.startsWith("user_management:")), "team_lead must not manage users org-wide");
  } finally {
    await pool.end();
  }
});

test("agent_operator holds no administrative agent capability (create/update/delete/lifecycle_control)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    const permissions = await service.getRolePermissions(PlatformRoleName.AGENT_OPERATOR);
    for (const admin of [PermissionName.AGENT_CREATE, PermissionName.AGENT_UPDATE, PermissionName.AGENT_DELETE, PermissionName.AGENT_LIFECYCLE_CONTROL]) {
      assert.ok(!permissions.includes(admin), `agent_operator must not hold ${admin}`);
    }
  } finally {
    await pool.end();
  }
});

test("finance_manager holds no agent_management or RBAC/user_management permission", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    const permissions = await service.getRolePermissions(PlatformRoleName.FINANCE_MANAGER);
    assert.ok(!permissions.some((p) => p.startsWith("agent_management:")), "finance_manager must not have agent lifecycle authority");
    assert.ok(!permissions.some((p) => p.startsWith("user_management:")), "finance_manager must not have user management authority");
    assert.ok(!permissions.includes(PermissionName.TENANT_RBAC_MANAGE), "finance_manager must not have RBAC management authority");
  } finally {
    await pool.end();
  }
});

test("compliance_officer holds no agent_management or credit_management permission", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    const permissions = await service.getRolePermissions(PlatformRoleName.COMPLIANCE_OFFICER);
    assert.ok(!permissions.some((p) => p.startsWith("agent_management:")), "compliance_officer must not have agent lifecycle authority");
    assert.ok(!permissions.some((p) => p.startsWith("credit_management:")), "compliance_officer must not have credit management authority");
  } finally {
    await pool.end();
  }
});

test("getRoles returns all 5 roles each with a non-empty permissions array", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    const roles = await service.getRoles();
    assert.equal(roles.length, 5);
    for (const role of roles) {
      assert.ok(role.permissions.length > 0, `${role.name} must have at least one permission`);
    }
  } finally {
    await pool.end();
  }
});

test("getPermissions groups all permissions by feature area, covering all 8 areas", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    const grouped = await service.getPermissions();
    assert.equal(grouped.length, 8);
    const total = grouped.reduce((sum, g) => sum + g.permissions.length, 0);
    assert.equal(total, ALL_PERMISSION_NAMES.length);
  } finally {
    await pool.end();
  }
});

test("hasPermission is genuinely role-specific, not a blanket true/false", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const service = new RbacDefinitionService(pool);
  try {
    assert.equal(await service.hasPermission(PlatformRoleName.PLATFORM_ADMIN, PermissionName.AGENT_CREATE), true);
    assert.equal(await service.hasPermission(PlatformRoleName.AGENT_OPERATOR, PermissionName.AGENT_CREATE), false);
  } finally {
    await pool.end();
  }
});
