import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AuditLogController } from "../../../src/audit/query/audit-log.controller";
import { AuditLogQueryRepository } from "../../../src/audit/query/audit-log-query.repository";
import { AuditLogQueryService } from "../../../src/audit/query/audit-log-query.service";
import { AuditStoreRepository } from "../../../src/audit/audit-store.repository";
import { PermissionName } from "../../../src/rbac/rbac.constants";
import { RbacGuard } from "../../../src/rbac/rbac.guard";
import { REQUIRE_ANY_PERMISSION_KEY } from "../../../src/rbac/require-any-permission.decorator";
import { TeamMembershipRepository } from "../../../src/rbac/team-membership.repository";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-audit-rbac-${Math.random().toString(36).slice(2, 10)}`;
}

function amsAppPool(): Pool {
  const appUrl = new URL(DATABASE_URL!);
  appUrl.username = "ams_app";
  return new Pool({ connectionString: appUrl.toString() });
}

async function cleanupTenant(adminPool: Pool, slug: string): Promise<void> {
  const tenant = await adminPool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function withTenantContext<T>(pool: Pool, tenantId: string, fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function fakeReflector(metadata: Record<string, unknown>) {
  return { getAllAndOverride: (key: string) => metadata[key] } as any;
}

function fakeContext(req: Record<string, unknown>): any {
  return { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => req }) };
}

test("RBAC end-to-end: compliance_officer (view_org) sees ALL tenant audit events; team_lead (view_team) sees only their team's; agent_operator (neither) is denied by RbacGuard before the controller ever runs", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit RBAC ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const teamA = await adminPool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team A') RETURNING id", [tenant.id]);
    const teamAId = teamA.rows[0].id;
    const teamLeadUserId = "11111111-1111-1111-1111-111111111111";
    const outsiderUserId = "22222222-2222-2222-2222-222222222222";
    await adminPool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, 'lead@example.com', 'Team Lead')", [teamLeadUserId, tenant.id]);
    await adminPool.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, 'outsider@example.com', 'Outsider')", [outsiderUserId, tenant.id]);
    await adminPool.query("INSERT INTO team_members (team_id, tenant_id, user_id) VALUES ($1, $2, $3)", [teamAId, tenant.id, teamLeadUserId]);

    const storeRepository = new AuditStoreRepository(appPool);
    const base = new Date();
    await withTenantContext(appPool, tenant.id, async (client) => {
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: teamLeadUserId, action: "team.action", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client, base);
      await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: outsiderUserId, action: "outsider.action", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: {} }, client, new Date(base.getTime() + 1000));
    });

    const queryRepository = new AuditLogQueryRepository(appPool);
    const queryService = new AuditLogQueryService(appPool, queryRepository);
    const controller = new AuditLogController(queryService);
    const teamMembershipRepository = new TeamMembershipRepository(appPool);
    const guard = new RbacGuard(fakeReflector({ [REQUIRE_ANY_PERMISSION_KEY]: [PermissionName.AUDIT_LOGS_VIEW_ORG, PermissionName.AUDIT_LOGS_VIEW_TEAM] }), teamMembershipRepository, audit);

    const dto: any = { startTime: new Date(base.getTime() - 60_000).toISOString(), endTime: new Date(base.getTime() + 60_000).toISOString(), resourceType: "test_resource" };

    // compliance_officer: org-wide, sees BOTH events.
    const complianceReq = { tenantId: tenant.id, actorId: outsiderUserId, roles: ["compliance_officer"], permissions: [PermissionName.AUDIT_LOGS_VIEW_ORG] } as any;
    assert.equal(await guard.canActivate(fakeContext(complianceReq)), true);
    const orgResult = await withTenantContext(appPool, tenant.id, (client) => {
      complianceReq.tenantDbClient = client;
      return controller.listLogs(dto, complianceReq);
    });
    assert.equal(orgResult.entries.length, 2);
    assert.equal(orgResult.scope, "org");

    // team_lead: team-scoped, sees ONLY their own team's event.
    const teamLeadReq = { tenantId: tenant.id, actorId: teamLeadUserId, roles: ["team_lead"], permissions: [PermissionName.AUDIT_LOGS_VIEW_TEAM] } as any;
    assert.equal(await guard.canActivate(fakeContext(teamLeadReq)), true);
    const teamResult = await withTenantContext(appPool, tenant.id, (client) => {
      teamLeadReq.tenantDbClient = client;
      return controller.listLogs(dto, teamLeadReq);
    });
    assert.equal(teamResult.entries.length, 1);
    assert.equal(teamResult.entries[0].action, "team.action");
    assert.equal(teamResult.scope, "team");

    // agent_operator: neither permission — RbacGuard denies BEFORE the controller/service ever runs.
    const unauthorizedReq = { tenantId: tenant.id, actorId: outsiderUserId, originalUrl: "/api/v1/audit/logs", method: "GET", roles: ["agent_operator"], permissions: ["agent_management:agent:trigger"] } as any;
    await assert.rejects(
      () => guard.canActivate(fakeContext(unauthorizedReq)),
      (err: any) => {
        assert.equal(err.getResponse().error, "forbidden");
        return true;
      },
    );
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
