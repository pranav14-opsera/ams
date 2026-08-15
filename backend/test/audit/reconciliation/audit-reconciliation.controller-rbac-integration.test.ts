import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AuditReconciliationController } from "../../../src/audit/reconciliation/audit-reconciliation.controller";
import { AuditReconciliationReportRepository } from "../../../src/audit/reconciliation/audit-reconciliation-report.repository";
import { AuditReplayService } from "../../../src/audit/reconciliation/audit-replay.service";
import { PermissionName } from "../../../src/rbac/rbac.constants";
import { RbacGuard } from "../../../src/rbac/rbac.guard";
import { REQUIRE_ANY_PERMISSION_KEY } from "../../../src/rbac/require-any-permission.decorator";
import { REQUIRE_PERMISSION_KEY } from "../../../src/rbac/require-permission.decorator";
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
  return `test-audit-recon-rbac-${Math.random().toString(36).slice(2, 10)}`;
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
  await adminPool.query("DELETE FROM audit_reconciliation_reports WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM audit_events_dlq WHERE tenant_id = $1", [tenantId]);
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

test("RBAC: GET /reports is reachable by compliance_officer (view_org) and team_lead-only agent_operator is denied; POST /replay is platform_admin-only", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Recon RBAC ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const reportRepository = new AuditReconciliationReportRepository(appPool);
    await withTenantContext(appPool, tenant.id, (client) =>
      reportRepository.create(
        {
          tenantId: tenant.id,
          reportType: "daily_reconciliation",
          periodStart: new Date(Date.now() - 60_000),
          periodEnd: new Date(),
          expectedCount: 10,
          actualCount: 10,
          gapCount: 0,
          gapPercentage: 0,
          tolerancePercentage: 0.1,
          status: "healthy",
          alertTriggered: false,
          details: {},
        },
        client,
      ),
    );

    const replayService = new AuditReplayService(appPool, { process: async () => ({ accepted: true, deadLettered: false }) } as any);
    const controller = new AuditReconciliationController(reportRepository, replayService);
    const teamMembershipRepository = new TeamMembershipRepository(appPool);
    const guard = new RbacGuard(
      fakeReflector({ [REQUIRE_ANY_PERMISSION_KEY]: [PermissionName.AUDIT_LOGS_VIEW_ORG, PermissionName.AUDIT_PHI_MONITORING_VIEW] }),
      teamMembershipRepository,
      audit,
    );

    // compliance_officer holds AUDIT_PHI_MONITORING_VIEW (not view_org) — still allowed via the OR-permission decorator.
    const complianceReq = { tenantId: tenant.id, actorId: null, roles: ["compliance_officer"], permissions: [PermissionName.AUDIT_PHI_MONITORING_VIEW] } as any;
    assert.equal(await guard.canActivate(fakeContext(complianceReq)), true);
    const listResult = await withTenantContext(appPool, tenant.id, (client) => {
      complianceReq.tenantDbClient = client;
      return controller.listReports({} as any, complianceReq);
    });
    assert.equal(listResult.reports.length, 1);
    assert.equal(listResult.reports[0].reportType, "daily_reconciliation");

    // team_lead holds only view_team — neither view_org nor phi_monitoring_view — denied before the controller runs.
    const teamLeadGuard = new RbacGuard(
      fakeReflector({ [REQUIRE_ANY_PERMISSION_KEY]: [PermissionName.AUDIT_LOGS_VIEW_ORG, PermissionName.AUDIT_PHI_MONITORING_VIEW] }),
      teamMembershipRepository,
      audit,
    );
    const teamLeadReq = { tenantId: tenant.id, actorId: null, originalUrl: "/api/v1/audit/reconciliation/reports", method: "GET", roles: ["team_lead"], permissions: [PermissionName.AUDIT_LOGS_VIEW_TEAM] } as any;
    await assert.rejects(
      () => teamLeadGuard.canActivate(fakeContext(teamLeadReq)),
      (err: any) => {
        assert.equal(err.getResponse().error, "forbidden");
        return true;
      },
    );

    // platform_admin holds tenant_configuration:rbac:manage — the one permission that gates /replay.
    const replayGuard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: PermissionName.TENANT_RBAC_MANAGE }), teamMembershipRepository, audit);
    const adminReq = { tenantId: tenant.id, actorId: null, roles: ["platform_admin"], permissions: [PermissionName.TENANT_RBAC_MANAGE] } as any;
    assert.equal(await replayGuard.canActivate(fakeContext(adminReq)), true);
    const replayResult = await controller.replay({ since: new Date(Date.now() - 60_000).toISOString(), until: new Date().toISOString() }, adminReq);
    assert.equal(replayResult.attempted, 0);

    // compliance_officer lacks tenant_configuration:rbac:manage — denied on /replay even though it can read /reports.
    const complianceReplayGuard = new RbacGuard(fakeReflector({ [REQUIRE_PERMISSION_KEY]: PermissionName.TENANT_RBAC_MANAGE }), teamMembershipRepository, audit);
    const complianceReplayReq = { tenantId: tenant.id, actorId: null, originalUrl: "/api/v1/audit/reconciliation/replay", method: "POST", roles: ["compliance_officer"], permissions: [PermissionName.AUDIT_PHI_MONITORING_VIEW] } as any;
    await assert.rejects(
      () => complianceReplayGuard.canActivate(fakeContext(complianceReplayReq)),
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
