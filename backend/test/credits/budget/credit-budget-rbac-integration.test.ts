import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PermissionName } from "../../../src/rbac/rbac.constants";
import { RbacGuard } from "../../../src/rbac/rbac.guard";
import { REQUIRE_ANY_PERMISSION_KEY } from "../../../src/rbac/require-any-permission.decorator";
import { REQUIRE_PERMISSION_KEY } from "../../../src/rbac/require-permission.decorator";
import { RESOURCE_TEAM_PARAM_KEY } from "../../../src/rbac/resource-team-param.decorator";
import { TeamMembershipRepository } from "../../../src/rbac/team-membership.repository";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-budget-rbac-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM teams WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

function fakeReflector(metadata: Record<string, unknown>) {
  return { getAllAndOverride: (key: string) => metadata[key] } as any;
}

function fakeContext(req: Record<string, unknown>): any {
  return { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => req }) };
}

// AC: "RBAC enforcement: only Finance Manager and Platform Administrator can POST/PUT ... Team Lead can GET their own team's budget; Agent Operator can GET their team's remaining balance" — this reuses RbacGuard's own generic ResourceTeamParam mechanism (the exact same one WO-047's audit-log RBAC test exercises), matching CreditBudgetController's real @ResourceTeamParam("teamId") + @RequireAnyPermission decorators on GET /budgets/:teamId.
test("real Postgres: RbacGuard enforces GET /budgets/:teamId per the AC — org roles pass for any team, team-scoped roles only pass for their OWN team", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(pool);
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), audit);
    const tenant = await saga.provision({ name: `Budget RBAC ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const teamA = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team A') RETURNING id", [tenant.id])).rows[0].id;
    const teamB = (await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team B') RETURNING id", [tenant.id])).rows[0].id;

    const teamLeadUserId = "11111111-1111-1111-1111-111111111111";
    await pool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, 'lead@example.com', 'Team A Lead')", [teamLeadUserId, tenant.id]);
    await pool.query("INSERT INTO team_members (team_id, tenant_id, user_id) VALUES ($1, $2, $3)", [teamA, tenant.id, teamLeadUserId]);

    const teamMembershipRepository = new TeamMembershipRepository(pool);
    const guard = new RbacGuard(
      fakeReflector({
        [REQUIRE_ANY_PERMISSION_KEY]: [PermissionName.CREDIT_CONSUMPTION_VIEW_ORG, PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM, PermissionName.CREDIT_CONSUMPTION_VIEW_PERSONAL],
        [RESOURCE_TEAM_PARAM_KEY]: "teamId",
      }),
      teamMembershipRepository,
      audit,
    );

    // Finance Manager / Platform Administrator (org-wide view): passes for ANY team, including one they aren't a member of.
    const financeManagerReq = { tenantId: tenant.id, actorId: "22222222-2222-2222-2222-222222222222", roles: ["finance_manager"], permissions: [PermissionName.CREDIT_CONSUMPTION_VIEW_ORG], params: { teamId: teamB } };
    assert.equal(await guard.canActivate(fakeContext(financeManagerReq)), true);

    // Team Lead requesting THEIR OWN team's budget: passes.
    const ownTeamReq = { tenantId: tenant.id, actorId: teamLeadUserId, roles: ["team_lead"], permissions: [PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM], params: { teamId: teamA } };
    assert.equal(await guard.canActivate(fakeContext(ownTeamReq)), true);

    // Team Lead requesting a DIFFERENT team's budget: denied by the resource-team-param cross-team check, before the controller/service ever runs.
    const crossTeamReq = {
      tenantId: tenant.id,
      actorId: teamLeadUserId,
      roles: ["team_lead"],
      permissions: [PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM],
      params: { teamId: teamB },
      originalUrl: "/api/v1/credits/budgets/" + teamB,
      method: "GET",
    };
    await assert.rejects(
      () => guard.canActivate(fakeContext(crossTeamReq)),
      (err: any) => {
        assert.equal(err.getResponse().error, "forbidden");
        return true;
      },
    );

    // Agent Operator with no matching permission at all: denied outright.
    const unauthorizedReq = {
      tenantId: tenant.id,
      actorId: "33333333-3333-3333-3333-333333333333",
      roles: ["agent_operator"],
      permissions: ["agent_management:agent:trigger"],
      params: { teamId: teamA },
      originalUrl: "/api/v1/credits/budgets/" + teamA,
      method: "GET",
    };
    await assert.rejects(() => guard.canActivate(fakeContext(unauthorizedReq)));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: RbacGuard denies POST /allocate outright for a caller without CREDIT_ALLOCATION_MANAGE (e.g. a Team Lead)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const auditService = new InMemoryAuditService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const tenant = await saga.provision({ name: `Budget Allocate RBAC ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const teamMembershipRepository = new TeamMembershipRepository(pool);
    const guard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: PermissionName.CREDIT_ALLOCATION_MANAGE }), teamMembershipRepository, auditService as any);

    const teamLeadReq = { tenantId: tenant.id, actorId: "11111111-1111-1111-1111-111111111111", roles: ["team_lead"], permissions: [PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM], originalUrl: "/api/v1/credits/allocate", method: "POST" };
    await assert.rejects(() => guard.canActivate(fakeContext(teamLeadReq)));

    const financeManagerReq = { tenantId: tenant.id, actorId: "22222222-2222-2222-2222-222222222222", roles: ["finance_manager"], permissions: [PermissionName.CREDIT_ALLOCATION_MANAGE] };
    assert.equal(await guard.canActivate(fakeContext(financeManagerReq)), true);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
