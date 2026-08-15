import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-agents-${Math.random().toString(36).slice(2, 10)}`;
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

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const repository = new AgentsRepository(pool);
  const service = new AgentsService(pool, repository, encryptionService, audit, buildAdapterHealthService(pool));
  return { saga, service, repository };
}

test("create returns the documented resource shape and never includes connection_config", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Test Co", slug, dataResidencyRegion: "us", actorId: null });

    const resource = await service.create(pool, tenant.id, null, {
      name: "Support Bot",
      framework: "langchain",
      connectionConfig: { apiKey: "sk-super-secret-value" },
    });

    assert.ok(resource.id);
    assert.equal(resource.tenantId, tenant.id);
    assert.equal(resource.framework, "langchain");
    assert.equal(resource.lifecycleStatus, "connecting");
    assert.ok(resource.registeredAt);
    assert.ok(!("connectionConfig" in resource), "connection credentials must never appear in the API response");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("connection_config is genuinely encrypted at rest — the ciphertext never contains the plaintext secret", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Encryption Co", slug, dataResidencyRegion: "us", actorId: null });
    const secretValue = "sk-do-not-leak-this-0000000000";

    const resource = await service.create(pool, tenant.id, null, { name: "Secret Agent", framework: "crewai", connectionConfig: { apiKey: secretValue } });

    const row = await pool.query("SELECT connection_config_ciphertext FROM agents WHERE id = $1", [resource.id]);
    const ciphertext = row.rows[0].connection_config_ciphertext as Buffer;
    assert.ok(!ciphertext.toString("utf8").includes(secretValue), "the stored ciphertext must not contain the plaintext credential");
    assert.ok(!ciphertext.toString("base64").includes(Buffer.from(secretValue).toString("base64")));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("rejects a duplicate agent name within the same tenant with 409", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Dup Co", slug, dataResidencyRegion: "us", actorId: null });
    await service.create(pool, tenant.id, null, { name: "Dup Bot", framework: "autogen", connectionConfig: {} });

    await assert.rejects(
      () => service.create(pool, tenant.id, null, { name: "Dup Bot", framework: "autogen", connectionConfig: {} }),
      (err: any) => {
        assert.equal(err.getStatus(), 409);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("findAll returns only the requesting tenant's agents — cross-tenant queries return zero results", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slugA = randomSlug();
  const slugB = randomSlug();
  try {
    const tenantA = await saga.provision({ name: "Agent Tenant A", slug: slugA, dataResidencyRegion: "us", actorId: null });
    const tenantB = await saga.provision({ name: "Agent Tenant B", slug: slugB, dataResidencyRegion: "us", actorId: null });

    await service.create(pool, tenantA.id, null, { name: "A-Bot-1", framework: "langchain", connectionConfig: {} });
    await service.create(pool, tenantA.id, null, { name: "A-Bot-2", framework: "crewai", connectionConfig: {} });
    await service.create(pool, tenantB.id, null, { name: "B-Bot-1", framework: "autogen", connectionConfig: {} });

    const resultA = await service.findAll(pool, tenantA.id, {});
    const resultB = await service.findAll(pool, tenantB.id, {});

    assert.equal(resultA.total, 2);
    assert.equal(resultB.total, 1);
    assert.ok(resultA.agents.every((a) => a.tenantId === tenantA.id));
    assert.ok(!resultA.agents.some((a) => a.name === "B-Bot-1"), "tenant A must never see tenant B's agents");
  } finally {
    await cleanupTenant(pool, slugA);
    await cleanupTenant(pool, slugB);
    await pool.end();
  }
});

test("findAll supports filtering by framework, lifecycleStatus, teamId, and name substring", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Filter Co", slug, dataResidencyRegion: "us", actorId: null });
    const team = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team Alpha') RETURNING id", [tenant.id]);

    await service.create(pool, tenant.id, null, { name: "Billing Assistant", framework: "langchain", teamId: team.rows[0].id, connectionConfig: {} });
    await service.create(pool, tenant.id, null, { name: "Support Assistant", framework: "crewai", connectionConfig: {} });

    assert.equal((await service.findAll(pool, tenant.id, { framework: "langchain" })).total, 1);
    assert.equal((await service.findAll(pool, tenant.id, { teamId: team.rows[0].id })).total, 1);
    assert.equal((await service.findAll(pool, tenant.id, { name: "Assistant" })).total, 2);
    assert.equal((await service.findAll(pool, tenant.id, { name: "Billing" })).total, 1);
    assert.equal((await service.findAll(pool, tenant.id, { lifecycleStatus: "connecting" })).total, 2);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("findAll paginates via limit/offset", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Page Co", slug, dataResidencyRegion: "us", actorId: null });
    for (let i = 0; i < 5; i++) {
      await service.create(pool, tenant.id, null, { name: `Bot-${i}`, framework: "generic_rest", connectionConfig: {} });
    }

    const page1 = await service.findAll(pool, tenant.id, { limit: 2, offset: 0 });
    const page2 = await service.findAll(pool, tenant.id, { limit: 2, offset: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page1.agents.length, 2);
    assert.equal(page2.agents.length, 2);
    assert.notDeepEqual(page1.agents.map((a) => a.id), page2.agents.map((a) => a.id));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("findOne returns 404 for an unknown id", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent 404 Co", slug, dataResidencyRegion: "us", actorId: null });
    await assert.rejects(
      () => service.findOne(pool, tenant.id, "00000000-0000-0000-0000-000000000099"),
      (err: any) => {
        assert.equal(err.getStatus(), 404);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("update changes name/team/metadata and re-encrypts connection_config only when provided", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Update Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await service.create(pool, tenant.id, null, { name: "Original Bot", framework: "langchain", connectionConfig: { apiKey: "original" } });

    const originalCiphertext = (await pool.query("SELECT connection_config_ciphertext FROM agents WHERE id = $1", [created.id])).rows[0].connection_config_ciphertext;

    const updated = await service.update(pool, tenant.id, null, created.id, { name: "Renamed Bot", metadata: { tag: "v2" } });
    assert.equal(updated.name, "Renamed Bot");
    assert.deepEqual(updated.metadata, { tag: "v2" });

    const unchangedCiphertext = (await pool.query("SELECT connection_config_ciphertext FROM agents WHERE id = $1", [created.id])).rows[0].connection_config_ciphertext;
    assert.deepEqual(unchangedCiphertext, originalCiphertext, "connection_config must NOT be re-encrypted when the update doesn't touch it");

    await service.update(pool, tenant.id, null, created.id, { connectionConfig: { apiKey: "rotated" } });
    const rotatedCiphertext = (await pool.query("SELECT connection_config_ciphertext FROM agents WHERE id = $1", [created.id])).rows[0].connection_config_ciphertext;
    assert.notDeepEqual(rotatedCiphertext, originalCiphertext, "connection_config MUST be re-encrypted when explicitly provided in the update");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("update rejects renaming to another agent's existing name with 409", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Rename Conflict Co", slug, dataResidencyRegion: "us", actorId: null });
    await service.create(pool, tenant.id, null, { name: "Taken Name", framework: "langchain", connectionConfig: {} });
    const other = await service.create(pool, tenant.id, null, { name: "Other Bot", framework: "crewai", connectionConfig: {} });

    await assert.rejects(
      () => service.update(pool, tenant.id, null, other.id, { name: "Taken Name" }),
      (err: any) => {
        assert.equal(err.getStatus(), 409);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("remove soft-deletes (lifecycle_status -> decommissioned) rather than removing the row", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Delete Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await service.create(pool, tenant.id, null, { name: "Decom Bot", framework: "langchain", connectionConfig: {} });

    const removed = await service.remove(pool, tenant.id, null, created.id);
    assert.equal(removed.lifecycleStatus, "decommissioned");

    const row = await pool.query("SELECT lifecycle_status FROM agents WHERE id = $1", [created.id]);
    assert.equal(row.rows.length, 1, "the row must still exist — hard delete is never exposed");
    assert.equal(row.rows[0].lifecycle_status, "decommissioned");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("every create/update/delete operation produces an immutable audit_events entry", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { saga, service } = await buildRig(pool);
  const slug = randomSlug();
  try {
    const tenant = await saga.provision({ name: "Agent Audit Co", slug, dataResidencyRegion: "us", actorId: null });
    const actorId = (await pool.query("INSERT INTO users (tenant_id, email, display_name) VALUES ($1, 'actor@example.com', 'Actor') RETURNING id", [tenant.id])).rows[0].id;
    const created = await service.create(pool, tenant.id, actorId, { name: "Audited Bot", framework: "langchain", connectionConfig: {} });
    await service.update(pool, tenant.id, actorId, created.id, { name: "Audited Bot Renamed" });
    await service.remove(pool, tenant.id, actorId, created.id);

    const rows = await pool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND resource_id = $2 ORDER BY occurred_at", [tenant.id, created.id]);
    assert.deepEqual(rows.rows.map((r) => r.action), ["agent.created", "agent.updated", "agent.decommissioned"]);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
