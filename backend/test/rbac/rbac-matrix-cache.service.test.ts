import { test } from "node:test";
import assert from "node:assert/strict";
import { RbacMatrixCacheService } from "../../src/rbac/rbac-matrix-cache.service";

function fakeDefinitionService(roles: { name: string; permissions: string[] }[]) {
  let callCount = 0;
  return {
    callCount: () => callCount,
    service: { getRoles: async () => { callCount++; return roles; } },
  };
}

test("getGrantingRoles returns every role that grants the given permission", async () => {
  const { service } = fakeDefinitionService([
    { name: "platform_admin", permissions: ["agent_management:agent:create"] },
    { name: "finance_manager", permissions: ["credit_management:allocation:manage"] },
  ]);
  const cache = new RbacMatrixCacheService(service as any);

  assert.deepEqual(await cache.getGrantingRoles("agent_management:agent:create"), ["platform_admin"]);
  assert.deepEqual(await cache.getGrantingRoles("credit_management:allocation:manage"), ["finance_manager"]);
});

test("getGrantingRoles returns an empty array for a permission no role grants", async () => {
  const { service } = fakeDefinitionService([{ name: "platform_admin", permissions: ["agent_management:agent:create"] }]);
  const cache = new RbacMatrixCacheService(service as any);
  assert.deepEqual(await cache.getGrantingRoles("nonexistent:permission:here"), []);
});

test("multiple roles granting the same permission are all returned", async () => {
  const { service } = fakeDefinitionService([
    { name: "team_lead", permissions: ["audit_access:logs:view_team"] },
    { name: "platform_admin", permissions: ["audit_access:logs:view_team"] },
  ]);
  const cache = new RbacMatrixCacheService(service as any);
  assert.deepEqual(new Set(await cache.getGrantingRoles("audit_access:logs:view_team")), new Set(["team_lead", "platform_admin"]));
});

test("hasPermission checks a specific role against the granting-roles list", async () => {
  const { service } = fakeDefinitionService([{ name: "platform_admin", permissions: ["agent_management:agent:create"] }]);
  const cache = new RbacMatrixCacheService(service as any);
  assert.equal(await cache.hasPermission("platform_admin", "agent_management:agent:create"), true);
  assert.equal(await cache.hasPermission("agent_operator", "agent_management:agent:create"), false);
});

test("caches the matrix snapshot: repeated lookups within the TTL hit the cache, not the underlying service", async () => {
  const { service, callCount } = fakeDefinitionService([{ name: "platform_admin", permissions: ["agent_management:agent:create"] }]);
  const cache = new RbacMatrixCacheService(service as any);

  await cache.getGrantingRoles("agent_management:agent:create");
  await cache.getGrantingRoles("agent_management:agent:create");
  await cache.hasPermission("platform_admin", "agent_management:agent:create");

  assert.equal(callCount(), 1, "getRoles must only be called once — the rest are served from the cached snapshot");
});
