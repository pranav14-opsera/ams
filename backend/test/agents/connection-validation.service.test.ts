import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { Pool } from "pg";
import { AgentInFlightOperationsService } from "../../src/agents/agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "../../src/agents/agent-state-transitions.repository";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { ConnectionValidationService } from "../../src/agents/connection-validation.service";
import { LifecycleService } from "../../src/agents/lifecycle.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const skip = !DATABASE_URL || !REDIS_URL;

function randomSlug(): string {
  return `test-cxn-val-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM agent_state_transitions WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const audit = new PostgresAuditService(pool);
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), audit);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const inFlightOperations = new AgentInFlightOperationsService();
  const pubsub = new RedisPubSubService();
  const lifecycleService = new LifecycleService(agentsRepository, new AgentStateTransitionsRepository(pool), audit, inFlightOperations, pubsub);
  const service = new ConnectionValidationService(pool, agentsRepository, lifecycleService);
  return { saga, encryptionService, agentsRepository, service, inFlightOperations, pubsub };
}

/** ioredis clients (RedisPubSubService) and the in-flight-operations timers keep the node:test process alive until explicitly torn down — same convention as lifecycle-integration.test.ts's own cleanup. */
async function teardownRig(rig: { inFlightOperations: AgentInFlightOperationsService; pubsub: RedisPubSubService }): Promise<void> {
  await rig.inFlightOperations.onModuleDestroy();
  await rig.pubsub.onModuleDestroy();
}

async function createConnectingAgent(pool: Pool, encryptionService: EncryptionService, agentsRepository: AgentsRepository, tenantId: string, framework: "langchain" | "generic_rest", connectionConfig: Record<string, unknown>) {
  const encrypted = await encryptionService.encrypt(tenantId, Buffer.from(JSON.stringify(connectionConfig), "utf8"));
  const hmac = await encryptionService.encrypt(tenantId, Buffer.from("secret"));
  return agentsRepository.create(pool, tenantId, `Agent ${Math.random()}`, framework, null, encrypted, {}, null, hmac);
}

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * ConnectionValidationService's own SSRF guard (isBlockedHost) rejects
 * loopback outright — so a "the endpoint IS reachable" test needs a real
 * non-loopback address to bind the fixture server on. Picks this
 * sandbox's first non-internal IPv4 interface (typically a private
 * 10.x/172.x Docker/VM bridge address, which the guard deliberately does
 * NOT block — see that function's own docstring on why).
 */
function findNonLoopbackIPv4(): string | null {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

test("validate transitions the agent to active and records success when the endpoint is reachable", { skip: skip || !findNonLoopbackIPv4() }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const server = createServer((_req, res) => res.writeHead(200).end("ok"));
  const rig = await buildRig(pool);
  try {
    const host = findNonLoopbackIPv4()!;
    const port = await listen(server, host);
    const { saga, encryptionService, agentsRepository, service } = rig;
    const tenant = await saga.provision({ name: "Cxn Val Co", slug, dataResidencyRegion: "us", actorId: null });

    const agent = await createConnectingAgent(pool, encryptionService, agentsRepository, tenant.id, "generic_rest", {
      baseUrl: `http://${host}:${port}`,
      healthCheckEndpoint: "/health",
    });

    await service.validate(tenant.id, null, agent.id, "generic_rest", { baseUrl: `http://${host}:${port}`, healthCheckEndpoint: "/health" });

    const updated = await agentsRepository.findOne(pool, tenant.id, agent.id);
    assert.equal(updated?.lifecycle_status, "active");
    assert.equal((updated?.metadata as any).connectionValidation.status, "success");
  } finally {
    server.close();
    await teardownRig(rig);
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("validate records a failed outcome and leaves the agent connecting when the endpoint refuses the connection", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const rig = await buildRig(pool);
  try {
    const { saga, encryptionService, agentsRepository, service } = rig;
    const tenant = await saga.provision({ name: "Cxn Val Co 2", slug, dataResidencyRegion: "us", actorId: null });

    // Bind a server, grab its port, then close it immediately — a
    // subsequent connect to that same port on localhost fails fast with
    // ECONNREFUSED (unlike an unassigned low port such as :1, which some
    // OS network stacks are slow to reject), keeping this test quick and
    // deterministic.
    const closedServer = createServer();
    const closedPort = await listen(closedServer);
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));
    const config = { baseUrl: `http://127.0.0.1:${closedPort}`, healthCheckEndpoint: "/health" };
    const agent = await createConnectingAgent(pool, encryptionService, agentsRepository, tenant.id, "generic_rest", config);

    await service.validate(tenant.id, null, agent.id, "generic_rest", config);

    const updated = await agentsRepository.findOne(pool, tenant.id, agent.id);
    assert.equal(updated?.lifecycle_status, "connecting");
    assert.equal((updated?.metadata as any).connectionValidation.status, "failed");
  } finally {
    await teardownRig(rig);
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("validate rejects a loopback/private host outright as a minimal SSRF guard", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const rig = await buildRig(pool);
  try {
    const { saga, encryptionService, agentsRepository, service } = rig;
    const tenant = await saga.provision({ name: "Cxn Val Co 3", slug, dataResidencyRegion: "us", actorId: null });

    const config = { callbackUrl: "http://localhost:9999/callback" };
    const agent = await createConnectingAgent(pool, encryptionService, agentsRepository, tenant.id, "langchain", config);

    await service.validate(tenant.id, null, agent.id, "langchain", config);

    const updated = await agentsRepository.findOne(pool, tenant.id, agent.id);
    assert.equal(updated?.lifecycle_status, "connecting");
    assert.equal((updated?.metadata as any).connectionValidation.status, "failed");
    assert.match((updated?.metadata as any).connectionValidation.message, /not permitted/);
  } finally {
    await teardownRig(rig);
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("validate records a failure for a framework with no schema-defined validation URL (e.g. crewai)", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const rig = await buildRig(pool);
  try {
    const { saga, encryptionService, agentsRepository, service } = rig;
    const tenant = await saga.provision({ name: "Cxn Val Co 4", slug, dataResidencyRegion: "us", actorId: null });

    const agent = await createConnectingAgent(pool, encryptionService, agentsRepository, tenant.id, "generic_rest", {});
    await service.validate(tenant.id, null, agent.id, "crewai" as any, {});

    const updated = await agentsRepository.findOne(pool, tenant.id, agent.id);
    assert.equal(updated?.lifecycle_status, "connecting");
    assert.equal((updated?.metadata as any).connectionValidation.status, "failed");
  } finally {
    await teardownRig(rig);
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
