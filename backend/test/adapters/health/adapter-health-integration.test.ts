import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AdapterRegistryService } from "../../../src/adapters/adapter-registry.service";
import { AdapterConfigurationRepository } from "../../../src/adapters/health/adapter-configuration.repository";
import { AdapterHealthCheckRepository } from "../../../src/adapters/health/adapter-health-check.repository";
import { AdapterHealthController } from "../../../src/adapters/health/adapter-health.controller";
import { AdapterHealthService } from "../../../src/adapters/health/adapter-health.service";
import { AgentsRepository } from "../../../src/agents/agents.repository";
import { AgentsService } from "../../../src/agents/agents.service";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { seedHealthCheckHistory } from "./fixtures/adapter-health-fixtures";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-adapter-health-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function resetAdapterConfig(pool: Pool, adapterType: string): Promise<void> {
  await pool.query("UPDATE adapter_configurations SET health_status = 'healthy', consecutive_failures = 0, last_health_check_at = NULL WHERE adapter_type = $1", [adapterType]);
  await pool.query("DELETE FROM adapter_health_checks WHERE adapter_type = $1", [adapterType]);
}

test("the compatibility matrix reflects the real seeded configuration for all 4 framework adapters", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const configRepo = new AdapterConfigurationRepository(pool);
    const service = new AdapterHealthService(configRepo, new AdapterHealthCheckRepository(pool), new AdapterRegistryService());
    const matrix = await service.getCompatibilityMatrix();
    assert.deepEqual(new Set(matrix.map((m) => m.adapterType)), new Set(["langchain", "crewai", "autogen", "generic_rest"]));
    assert.ok(matrix.every((m) => m.healthStatus === "healthy" || m.healthStatus === "degraded"));
  } finally {
    await pool.end();
  }
});

test("real health probe execution against a mock adapter endpoint transitions to 'degraded' after 3 consecutive failures, then recovers", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const adapterType = "crewai";
  try {
    await resetAdapterConfig(pool, adapterType);

    const configRepo = new AdapterConfigurationRepository(pool);
    const registry = new AdapterRegistryService();
    let shouldFail = true;
    registry.register(adapterType as any, { getHealthProbe: async () => (shouldFail ? { healthy: false, details: { reason: "mock endpoint down" } } : { healthy: true, latencyMs: 30 }) } as any);
    const service = new AdapterHealthService(configRepo, new AdapterHealthCheckRepository(pool), registry);

    await service.runHealthProbe(adapterType);
    let config = await configRepo.findByType(adapterType);
    assert.equal(config!.health_status, "healthy");
    assert.equal(config!.consecutive_failures, 1);

    await service.runHealthProbe(adapterType);
    config = await configRepo.findByType(adapterType);
    assert.equal(config!.consecutive_failures, 2);

    const third = await service.runHealthProbe(adapterType);
    assert.equal(third.becameDegraded, true);
    config = await configRepo.findByType(adapterType);
    assert.equal(config!.health_status, "degraded");
    assert.equal(config!.consecutive_failures, 3);

    shouldFail = false;
    await service.runHealthProbe(adapterType);
    config = await configRepo.findByType(adapterType);
    assert.equal(config!.health_status, "healthy");
    assert.equal(config!.consecutive_failures, 0);

    const health = await service.getAdapterHealth(adapterType);
    assert.equal(health.recentChecks.length, 4);
    assert.deepEqual(health.recentChecks.map((c) => c.status).reverse(), ["unhealthy", "unhealthy", "unhealthy", "healthy"]);
  } finally {
    await resetAdapterConfig(pool, adapterType);
    await pool.end();
  }
});

test("GET /api/v1/adapters/:type/health surfaces real persisted history (healthy -> degraded -> recovery pattern)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const adapterType = "autogen";
  try {
    await resetAdapterConfig(pool, adapterType);
    await seedHealthCheckHistory(pool, adapterType);

    const service = new AdapterHealthService(new AdapterConfigurationRepository(pool), new AdapterHealthCheckRepository(pool), new AdapterRegistryService());
    const controller = new AdapterHealthController(service);

    const health = await controller.getHealth(adapterType);
    assert.equal(health.recentChecks.length, 10);
    assert.equal(health.recentChecks[0].status, "healthy"); // most recent first
    assert.equal(health.recentChecks[health.recentChecks.length - 1].status, "healthy"); // oldest of the 10 most recent

    const matrixResponse = await controller.getCompatibilityMatrix();
    assert.ok(matrixResponse.adapters.some((a: any) => a.adapterType === adapterType));
  } finally {
    await resetAdapterConfig(pool, adapterType);
    await pool.end();
  }
});

test("registering an agent with a framework version OUTSIDE the adapter's supported range returns a warning, never a hard block", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const adapterHealthService = new AdapterHealthService(new AdapterConfigurationRepository(pool), new AdapterHealthCheckRepository(pool), new AdapterRegistryService());
    const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, adapterHealthService);

    const tenant = await saga.provision({ name: "Compat Warning Co", slug, dataResidencyRegion: "us", actorId: null });

    // langchain's seeded range is >=0.2.0 <0.4.0 — 0.9.0 is well outside it.
    const created = await agentsService.create(pool, tenant.id, null, {
      name: "Outdated LangChain Agent",
      framework: "langchain",
      connectionConfig: {},
      frameworkVersion: "0.9.0",
    });

    assert.ok(created.compatibilityWarning);
    assert.equal(created.compatibilityWarning!.compatible, false);
    assert.equal(created.compatibilityWarning!.supportedRange, ">=0.2.0 <0.4.0");

    // Still registered — never a hard block.
    const row = await pool.query("SELECT id FROM agents WHERE id = $1", [created.id]);
    assert.equal(row.rows.length, 1);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("registering an agent with a framework version WITHIN the adapter's supported range reports no warning content beyond compatible:true", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const adapterHealthService = new AdapterHealthService(new AdapterConfigurationRepository(pool), new AdapterHealthCheckRepository(pool), new AdapterRegistryService());
    const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, adapterHealthService);

    const tenant = await saga.provision({ name: "Compat OK Co", slug, dataResidencyRegion: "us", actorId: null });

    const created = await agentsService.create(pool, tenant.id, null, {
      name: "Current LangChain Agent",
      framework: "langchain",
      connectionConfig: {},
      frameworkVersion: "0.3.0",
    });

    assert.deepEqual(created.compatibilityWarning, { compatible: true, supportedRange: ">=0.2.0 <0.4.0" });
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("registering an agent without a frameworkVersion omits the compatibility warning entirely", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const adapterHealthService = new AdapterHealthService(new AdapterConfigurationRepository(pool), new AdapterHealthCheckRepository(pool), new AdapterRegistryService());
    const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, adapterHealthService);

    const tenant = await saga.provision({ name: "No Version Reported Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "No Version Agent", framework: "generic_rest", connectionConfig: {} });

    assert.equal(created.compatibilityWarning, undefined);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
