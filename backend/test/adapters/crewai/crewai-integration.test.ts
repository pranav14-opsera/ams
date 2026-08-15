import { buildAdapterHealthService } from "../../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Pool } from "pg";
import { AdapterRegistryService } from "../../../src/adapters/adapter-registry.service";
import { AdaptersController } from "../../../src/adapters/adapters.controller";
import { CrewAiAdapter } from "../../../src/adapters/crewai/crewai-adapter";
import { CrewAiConnectionValidator } from "../../../src/adapters/crewai/crewai-connection-validator";
import { HmacValidationMiddleware } from "../../../src/adapters/hmac-validation.middleware";
import { KafkaTelemetryProducerService } from "../../../src/adapters/kafka/kafka-telemetry-producer.service";
import { TelemetryDeadLetterRepository } from "../../../src/adapters/kafka/telemetry-dead-letter.repository";
import { TelemetryPipelineService } from "../../../src/adapters/pipeline/telemetry-pipeline.service";
import { TelemetrySchemaValidatorService } from "../../../src/adapters/telemetry-schema-validator.service";
import { AgentsRepository } from "../../../src/agents/agents.repository";
import { AgentsService } from "../../../src/agents/agents.service";
import { ClassificationRuleEngine } from "../../../src/classification/classification-rule-engine";
import { DataClassificationTagger } from "../../../src/classification/data-classification-tagger";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import * as fixtures from "./fixtures/crewai-event-payloads";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-crewai-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

function fakeReq(overrides: Record<string, unknown>) {
  return { headers: {}, method: "POST", originalUrl: "/api/v1/adapters/crewai/telemetry", body: {}, ...overrides } as any;
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const hmacMiddleware = new HmacValidationMiddleware(agentsRepository, encryptionService);

  const pipeline = new TelemetryPipelineService(
    pool,
    new TelemetrySchemaValidatorService(),
    new TenantRepository(),
    new DataClassificationTagger(new ClassificationRuleEngine()),
    new PhiScrubberService(),
    new KafkaTelemetryProducerService(),
    new TelemetryDeadLetterRepository(pool),
  );

  const registry = new AdapterRegistryService();
  registry.register("crewai", new CrewAiAdapter(new CrewAiConnectionValidator()));
  const controller = new AdaptersController(registry, pipeline);

  return { saga, agentsService, hmacMiddleware, controller };
}

test("a full multi-agent crew execution trace flows through HMAC -> translation -> pipeline, with hierarchy reconstructable from what's persisted", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "CrewAI Adapter Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "CrewAI Test Agent", framework: "crewai", connectionConfig: { crewConfigEndpoint: "http://localhost:9999" } });

    async function send(rawBodyObject: unknown): Promise<any> {
      const bodyBuffer = Buffer.from(JSON.stringify(rawBodyObject));
      const signature = createHmac("sha256", Buffer.from(created.hmacSecret, "hex")).update(bodyBuffer).digest("hex");
      const req = fakeReq({ headers: { "x-agent-id": created.id, "x-signature-256": signature }, body: rawBodyObject, rawBody: bodyBuffer });
      await hmacMiddleware.use(req, { status: () => ({ json: () => undefined }) } as any, () => undefined);
      return controller.ingestTelemetry("crewai", rawBodyObject, req);
    }

    const trace = fixtures.fullCrewExecutionTrace();
    for (const event of trace) {
      const envelope = fixtures.envelope(event, { agent_id: created.id, tenant_id: tenant.id });
      const result = await send(envelope);
      assert.equal(result.accepted, true);
    }

    const dlqRows = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1 ORDER BY created_at", [tenant.id]);
    assert.equal(dlqRows.rows.length, 6, "every event in the trace must be its own canonical event (no Kafka broker in this sandbox, so all 6 land in the DLQ)");

    const byType = Object.fromEntries(dlqRows.rows.map((r) => [r.payload.event_type + ":" + JSON.stringify(r.payload.metadata.taskId ?? null) + ":" + (r.payload.metadata.delegationFrom ?? ""), r.payload]));

    const kickoffRow = dlqRows.rows.find((r) => r.payload.metadata.crewName === "Research Crew")!;
    assert.equal(kickoffRow.payload.metadata.parentEventId, null);

    const taskStartedRow = dlqRows.rows.find((r) => r.payload.metadata.taskDescription === "Research the topic")!;
    assert.equal(taskStartedRow.payload.metadata.parentEventId, "crew-001");
    assert.equal(taskStartedRow.payload.metadata.crewId, "crew-001");

    const delegationRow = dlqRows.rows.find((r) => r.payload.metadata.delegationFrom === "manager")!;
    assert.equal(delegationRow.payload.metadata.parentEventId, "task-001");
    assert.equal(delegationRow.payload.metadata.delegationTo, "researcher");

    const toolUsageRow = dlqRows.rows.find((r) => r.payload.tool_call_name === "web_search")!;
    assert.equal(toolUsageRow.payload.metadata.parentEventId, "task-001");
    assert.equal(toolUsageRow.payload.tool_call_success, true);

    const taskCompletedRow = dlqRows.rows.find((r) => r.payload.event_type === "metric" && r.payload.metadata.taskId === "task-001" && r.payload.token_consumption === 600)!;
    assert.equal(taskCompletedRow.payload.metadata.parentEventId, "crew-001");
    assert.equal(taskCompletedRow.payload.latency_ms, 2500);

    const crewCompletedRow = dlqRows.rows.find((r) => r.payload.token_consumption === 1500)!;
    assert.equal(crewCompletedRow.payload.metadata.parentEventId, null);
    assert.equal(crewCompletedRow.payload.latency_ms, 2500);

    void byType; // kept for readability of the lookup helper above, not asserted on directly
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a task_failed event's PHI-containing error message is scrubbed before persistence to the dead-letter table", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "CrewAI PHI Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "CrewAI PHI Agent", framework: "crewai", connectionConfig: {} });

    const rawBodyObject = fixtures.envelope(fixtures.TASK_FAILED, { agent_id: created.id, tenant_id: tenant.id });
    const bodyBuffer = Buffer.from(JSON.stringify(rawBodyObject));
    const signature = createHmac("sha256", Buffer.from(created.hmacSecret, "hex")).update(bodyBuffer).digest("hex");
    const req = fakeReq({ headers: { "x-agent-id": created.id, "x-signature-256": signature }, body: rawBodyObject, rawBody: bodyBuffer });
    await hmacMiddleware.use(req, { status: () => ({ json: () => undefined }) } as any, () => undefined);
    await controller.ingestTelemetry("crewai", rawBodyObject, req);

    const dlqRow = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenant.id]);
    const storedError = dlqRow.rows[0].payload.metadata.error as string;
    assert.ok(!storedError.includes("123-45-6789"));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
