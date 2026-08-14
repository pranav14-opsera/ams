import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import { RbacGuard } from "../../src/rbac/rbac.guard";
import { NO_PERMISSION_REQUIRED_KEY } from "../../src/rbac/no-permission-required.decorator";
import { REQUIRE_PERMISSION_KEY } from "../../src/rbac/require-permission.decorator";
import { RESOURCE_TEAM_PARAM_KEY } from "../../src/rbac/resource-team-param.decorator";

const JWT_CLAIMS_FIXTURES = JSON.parse(readFileSync(join(__dirname, "../fixtures/rbac/jwt-claims-fixtures.json"), "utf8"));

function fakeReflector(metadata: Record<string, unknown>) {
  return { getAllAndOverride: (key: string) => metadata[key] } as any;
}

function fakeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function fakeAuditService() {
  const events: any[] = [];
  return { events, service: { recordEvent: async (event: any) => { events.push(event); } } };
}

function fakeTeamMembershipRepository(teamIdsByUser: Record<string, string[]>) {
  return { getUserTeamIds: async (_tenantId: string, userId: string) => teamIdsByUser[userId] ?? [] } as any;
}

test("allows the request when the required permission is present in the JWT-derived permissions claim", async () => {
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:create" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: "t1", actorId: "u1", roles: ["platform_admin"], permissions: ["agent_management:agent:create"] });

  assert.equal(await guard.canActivate(context), true);
  assert.equal(audit.events.length, 0, "no denial should be audited on an allowed request");
});

test("denies with a structured 403 when the required permission is absent from the caller's permissions", async () => {
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:delete" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: "t1", actorId: "u1", originalUrl: "/api/v1/agents/1", method: "DELETE", roles: ["agent_operator"], permissions: ["agent_management:agent:trigger"] });

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      const body = err.getResponse();
      assert.equal(body.error, "FORBIDDEN");
      assert.equal(body.required_permission, "agent_management:agent:delete");
      assert.ok(body.request_id);
      return true;
    },
  );
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].action, "rbac.access_denied");
  assert.equal(audit.events[0].details.denialReason, "insufficient_permission");
});

test("deny-by-default: a route with no @RequirePermission and no @NoPermissionRequired is denied", async () => {
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({}), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: "t1", actorId: "u1", originalUrl: "/api/v1/misconfigured", method: "GET", roles: ["platform_admin"], permissions: ["agent_management:agent:create"] });

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      assert.equal(err.getResponse().error, "FORBIDDEN");
      return true;
    },
  );
  assert.equal(audit.events[0].details.denialReason, "no_permission_declared");
});

test("@NoPermissionRequired allows the request through with no permission check at all", async () => {
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [NO_PERMISSION_REQUIRED_KEY]: true }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: "t1", actorId: "u1", roles: [], permissions: [] });

  assert.equal(await guard.canActivate(context), true);
  assert.equal(audit.events.length, 0);
});

test("no role assigned (deny-by-default): an empty permissions array denies even a declared-permission route", async () => {
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:read" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: "t1", actorId: "u1", roles: [], permissions: [] });

  await assert.rejects(() => guard.canActivate(context));
});

test("team-scoped role (team_lead) accessing their OWN team's resource is allowed", async () => {
  const audit = fakeAuditService();
  const teamRepo = fakeTeamMembershipRepository({ u1: ["team-a"] });
  const guard = new RbacGuard(
    fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:update", [RESOURCE_TEAM_PARAM_KEY]: "teamId" }),
    teamRepo,
    audit.service,
  );
  const context = fakeContext({ tenantId: "t1", actorId: "u1", roles: ["team_lead"], permissions: ["agent_management:agent:update"], params: { teamId: "team-a" } });

  assert.equal(await guard.canActivate(context), true);
});

test("team-scoped role (team_lead) accessing ANOTHER team's resource is denied (cross-team access)", async () => {
  const audit = fakeAuditService();
  const teamRepo = fakeTeamMembershipRepository({ u1: ["team-a"] });
  const guard = new RbacGuard(
    fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:update", [RESOURCE_TEAM_PARAM_KEY]: "teamId" }),
    teamRepo,
    audit.service,
  );
  const context = fakeContext({
    tenantId: "t1", actorId: "u1", originalUrl: "/api/v1/agents/1", method: "PATCH",
    roles: ["team_lead"], permissions: ["agent_management:agent:update"], params: { teamId: "team-b" },
  });

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      assert.equal(err.getResponse().error, "FORBIDDEN");
      return true;
    },
  );
  assert.equal(audit.events[0].details.denialReason, "cross_team_access");
});

test("a non-team-scoped role (platform_admin) is NOT subject to the team-scope check even when a route declares it", async () => {
  const audit = fakeAuditService();
  const teamRepo = fakeTeamMembershipRepository({ u1: [] }); // admin belongs to no team at all
  const guard = new RbacGuard(
    fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:update", [RESOURCE_TEAM_PARAM_KEY]: "teamId" }),
    teamRepo,
    audit.service,
  );
  const context = fakeContext({ tenantId: "t1", actorId: "u1", roles: ["platform_admin"], permissions: ["agent_management:agent:update"], params: { teamId: "team-b" } });

  assert.equal(await guard.canActivate(context), true);
});

test("a route with no @ResourceTeamParam skips the team-scope check entirely, even for a team-scoped role", async () => {
  const audit = fakeAuditService();
  const teamRepo = fakeTeamMembershipRepository({ u1: ["team-a"] });
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "credit_management:consumption:view_team" }), teamRepo, audit.service);
  const context = fakeContext({ tenantId: "t1", actorId: "u1", roles: ["team_lead"], permissions: ["credit_management:consumption:view_team"], params: {} });

  assert.equal(await guard.canActivate(context), true);
});

// --- Fixture-driven, per-role end-to-end authorization scenarios ---
// (test/fixtures/rbac/jwt-claims-fixtures.json), one for each of the 5
// canonical roles plus the unassigned-role deny-by-default case.

test("fixture: platform_admin is granted a permission within its documented scope", async () => {
  const claims = JWT_CLAIMS_FIXTURES.platform_admin;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:create" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  assert.equal(await guard.canActivate(context), true);
});

test("fixture: platform_admin is DENIED a finance-specific permission outside its scope", async () => {
  const claims = JWT_CLAIMS_FIXTURES.platform_admin;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "credit_management:budget:configure" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  await assert.rejects(() => guard.canActivate(context));
});

test("fixture: team_lead is granted a team-scoped permission for their own team", async () => {
  const claims = JWT_CLAIMS_FIXTURES.team_lead;
  const audit = fakeAuditService();
  const teamRepo = fakeTeamMembershipRepository({ [claims.sub]: [claims.team_id] });
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:update", [RESOURCE_TEAM_PARAM_KEY]: "teamId" }), teamRepo, audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions, params: { teamId: claims.team_id } });
  assert.equal(await guard.canActivate(context), true);
});

test("fixture: team_lead is DENIED the same permission for a DIFFERENT team", async () => {
  const claims = JWT_CLAIMS_FIXTURES.team_lead;
  const audit = fakeAuditService();
  const teamRepo = fakeTeamMembershipRepository({ [claims.sub]: [claims.team_id] });
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:update", [RESOURCE_TEAM_PARAM_KEY]: "teamId" }), teamRepo, audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions, params: { teamId: "some-other-team" } });
  await assert.rejects(() => guard.canActivate(context));
});

test("fixture: agent_operator is granted their day-to-day trigger permission", async () => {
  const claims = JWT_CLAIMS_FIXTURES.agent_operator;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:trigger" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  assert.equal(await guard.canActivate(context), true);
});

test("fixture: agent_operator is DENIED an administrative agent permission", async () => {
  const claims = JWT_CLAIMS_FIXTURES.agent_operator;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:delete" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  await assert.rejects(() => guard.canActivate(context));
});

test("fixture: finance_manager is granted a financial permission", async () => {
  const claims = JWT_CLAIMS_FIXTURES.finance_manager;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "credit_management:budget:configure" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  assert.equal(await guard.canActivate(context), true);
});

test("fixture: finance_manager is DENIED an agent-lifecycle permission", async () => {
  const claims = JWT_CLAIMS_FIXTURES.finance_manager;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:create" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  await assert.rejects(() => guard.canActivate(context));
});

test("fixture: compliance_officer is granted a compliance permission", async () => {
  const claims = JWT_CLAIMS_FIXTURES.compliance_officer;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "data_retention:policy:manage" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  assert.equal(await guard.canActivate(context), true);
});

test("fixture: compliance_officer is DENIED a credit-management permission", async () => {
  const claims = JWT_CLAIMS_FIXTURES.compliance_officer;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "credit_management:allocation:manage" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  await assert.rejects(() => guard.canActivate(context));
});

test("fixture: no_role_assigned is denied any permission at all (deny-by-default)", async () => {
  const claims = JWT_CLAIMS_FIXTURES.no_role_assigned;
  const audit = fakeAuditService();
  const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: "agent_management:agent:read" }), fakeTeamMembershipRepository({}), audit.service);
  const context = fakeContext({ tenantId: claims.tid, actorId: claims.sub, roles: claims.roles, permissions: claims.permissions });
  await assert.rejects(() => guard.canActivate(context));
});
