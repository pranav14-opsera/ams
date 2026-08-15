import { buildAdapterHealthService } from "../../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Pool } from "pg";
import { AdapterRegistryService } from "../../../src/adapters/adapter-registry.service";
import { AdaptersController } from "../../../src/adapters/adapters.controller";
import { HmacValidationMiddleware } from "../../../src/adapters/hmac-validation.middleware";
import { KafkaTelemetryProducerService } from "../../../src/adapters/kafka/kafka-telemetry-producer.service";
import { TelemetryDeadLetterRepository } from "../../../src/adapters/kafka/telemetry-dead-letter.repository";
import { LangChainAdapter } from "../../../src/adapters/langchain/langchain-adapter";
import { LangChainConnectionValidator } from "../../../src/adapters/langchain/langchain-connection-validator";
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
import * as fixtures from "./fixtures/langchain-callback-payloads";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-langchain-${Math.random().toString(36).slice(2, 8)}`;
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
  return { headers: {}, method: "POST", originalUrl: "/api/v1/adapters/langchain/telemetry", body: {}, ...overrides } as any;
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
  registry.register("langchain", new LangChainAdapter(new LangChainConnectionValidator()));
  const controller = new AdaptersController(registry, pipeline);

  return { saga, agentsService, hmacMiddleware, controller };
}

test("full pipeline: a real LangChain on_llm_start/on_llm_end pair -> HMAC -> adapter translation -> schema validation -> PHI scrub -> dead-letter fallback", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "LangChain Adapter Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "LangChain Test Agent", framework: "langchain", connectionConfig: { endpointUrl: "http://localhost:9999" } });

    async function send(rawBodyObject: unknown) {
      const bodyBuffer = Buffer.from(JSON.stringify(rawBodyObject));
      const signature = createHmac("sha256", Buffer.from(created.hmacSecret, "hex")).update(bodyBuffer).digest("hex");
      const req = fakeReq({ headers: { "x-agent-id": created.id, "x-signature-256": signature }, body: rawBodyObject, rawBody: bodyBuffer });
      let authenticated = false;
      await hmacMiddleware.use(req, { status: () => ({ json: () => undefined }) } as any, () => {
        authenticated = true;
      });
      assert.equal(authenticated, true);
      return controller.ingestTelemetry("langchain", rawBodyObject, req) as Promise<any>;
    }

    const startEnvelope = fixtures.envelope(fixtures.LLM_START, { agent_id: created.id, tenant_id: tenant.id });
    const startResult = await send(startEnvelope);
    assert.equal(startResult.accepted, true);

    const endEnvelope = { ...startEnvelope, event: fixtures.LLM_END_LEGACY_TOKEN_FORMAT };
    const endResult = await send(endEnvelope);
    assert.equal(endResult.accepted, true);
    assert.equal(endResult.deadLettered, true, "no Kafka broker exists in this sandbox — genuinely falls back to the DLQ");

    const dlqRows = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1 ORDER BY created_at", [tenant.id]);
    assert.equal(dlqRows.rows.length, 2, "both the start (TRACE) and end (METRIC) events must each be their own canonical event");
    assert.equal(dlqRows.rows[0].payload.event_type, "trace");
    assert.equal(dlqRows.rows[1].payload.event_type, "metric");
    assert.equal(dlqRows.rows[1].payload.latency_ms, 450);
    assert.equal(dlqRows.rows[1].payload.token_consumption, 200);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("an on_llm_error event with PHI in the error message is scrubbed before it's persisted to the dead-letter table", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "LangChain PHI Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "PHI Test Agent", framework: "langchain", connectionConfig: {} });

    const rawBodyObject = fixtures.envelope(fixtures.LLM_ERROR, { agent_id: created.id, tenant_id: tenant.id });
    const bodyBuffer = Buffer.from(JSON.stringify(rawBodyObject));
    const signature = createHmac("sha256", Buffer.from(created.hmacSecret, "hex")).update(bodyBuffer).digest("hex");
    const req = fakeReq({ headers: { "x-agent-id": created.id, "x-signature-256": signature }, body: rawBodyObject, rawBody: bodyBuffer });
    await hmacMiddleware.use(req, { status: () => ({ json: () => undefined }) } as any, () => undefined);

    await controller.ingestTelemetry("langchain", rawBodyObject, req);

    const dlqRow = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenant.id]);
    const storedError = dlqRow.rows[0].payload.metadata.error as string;
    assert.ok(!storedError.includes("123-45-6789"), "the SSN-shaped value in the LangChain error message must be scrubbed before persistence");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
