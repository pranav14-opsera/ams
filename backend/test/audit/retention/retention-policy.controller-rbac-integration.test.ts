import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { RetentionPolicyController } from "../../../src/audit/retention/retention-policy.controller";
import { RetentionPolicyRepository } from "../../../src/audit/retention/retention-policy.repository";
import { RetentionPolicyService } from "../../../src/audit/retention/retention-policy.service";
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
  return `test-retention-rbac-${Math.random().toString(36).slice(2, 10)}`;
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
  await adminPool.query("DELETE FROM retention_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function withTenantContext<T = any>(pool: Pool, tenantId: string, fn: (client: any) => Promise<T>): Promise<T> {
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

test("RBAC: retention-policies GET/POST/PUT are reachable by compliance_officer AND platform_admin, denied for team_lead", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Retention RBAC ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const repository = new RetentionPolicyRepository(appPool);
    const service = new RetentionPolicyService(repository, audit);
    const controller = new RetentionPolicyController(service);
    const teamMembershipRepository = new TeamMembershipRepository(appPool);
    const guard = new RbacGuard(
      fakeReflector({ [REQUIRE_ANY_PERMISSION_KEY]: [PermissionName.DATA_RETENTION_POLICY_MANAGE, PermissionName.TENANT_RBAC_MANAGE] }),
      teamMembershipRepository,
      audit,
    );

    // compliance_officer holds data_retention:policy:manage — allowed.
    const complianceReq = { tenantId: tenant.id, actorId: null, roles: ["compliance_officer"], permissions: [PermissionName.DATA_RETENTION_POLICY_MANAGE] } as any;
    assert.equal(await guard.canActivate(fakeContext(complianceReq)), true);
    const created = await withTenantContext(appPool, tenant.id, (client) => {
      complianceReq.tenantDbClient = client;
      return controller.create({ dataCategory: "audit_logs", retentionDays: 3000 }, complianceReq);
    });
    assert.equal(created.policy.retentionDays, 3000);

    // platform_admin holds tenant_configuration:rbac:manage (not data_retention:policy:manage itself) — still allowed via the OR-permission.
    const adminReq = { tenantId: tenant.id, actorId: null, roles: ["platform_admin"], permissions: [PermissionName.TENANT_RBAC_MANAGE] } as any;
    assert.equal(await guard.canActivate(fakeContext(adminReq)), true);
    const updated = await withTenantContext(appPool, tenant.id, (client) => {
      adminReq.tenantDbClient = client;
      return controller.update({ dataCategory: "audit_logs", retentionDays: 3100 }, adminReq);
    });
    assert.equal(updated.policy.retentionDays, 3100);

    const listed = await withTenantContext(appPool, tenant.id, (client) => {
      adminReq.tenantDbClient = client;
      return controller.list(adminReq);
    });
    assert.equal(listed.policies.find((p: any) => p.dataCategory === "audit_logs")!.retentionDays, 3100);

    // team_lead holds neither permission — denied before the controller ever runs.
    const teamLeadReq = { tenantId: tenant.id, actorId: null, originalUrl: "/api/v1/audit/retention-policies", method: "GET", roles: ["team_lead"], permissions: [PermissionName.AUDIT_LOGS_VIEW_TEAM] } as any;
    await assert.rejects(
      () => guard.canActivate(fakeContext(teamLeadReq)),
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

test("upsert() rejects an out-of-bounds retentionDays even for an authorized caller", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Retention Bounds ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const repository = new RetentionPolicyRepository(appPool);
    const service = new RetentionPolicyService(repository, audit);
    const controller = new RetentionPolicyController(service);

    await withTenantContext(appPool, tenant.id, (client) => controller.create({ dataCategory: "audit_logs", retentionDays: 10 }, { tenantId: tenant.id, actorId: null, tenantDbClient: client } as any)).then(
      () => assert.fail("should have thrown"),
      (err: any) => assert.match(err.message, /between 365 and 3650/),
    );
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
  }
});
