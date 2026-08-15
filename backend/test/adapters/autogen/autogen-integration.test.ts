import { buildAdapterHealthService } from "../../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Pool } from "pg";
import { AdapterRegistryService } from "../../../src/adapters/adapter-registry.service";
import { AdaptersController } from "../../../src/adapters/adapters.controller";
import { AutoGenAdapter } from "../../../src/adapters/autogen/autogen-adapter";
import { AutoGenConnectionValidator } from "../../../src/adapters/autogen/autogen-connection-validator";
import { HmacValidationMiddleware } from "../../../src/adapters/hmac-validation.middleware";
import { KafkaTelemetryProducerService } from "../../../src/adapters/kafka/kafka-telemetry-producer.service";
import { TelemetryDeadLetterRepository } from "../../../src/adapters/kafka/telemetry-dead-letter.repository";
import { MetricsAggregatorRepository } from "../../../src/adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorService } from "../../../src/adapters/metrics/metrics-aggregator.service";
import { TelemetryPipelineService } from "../../../src/adapters/pipeline/telemetry-pipeline.service";
import { TelemetrySchemaValidatorService } from "../../../src/adapters/telemetry-schema-validator.service";
import { AgentsRepository } from "../../../src/agents/agents.repository";
import { AgentsService } from "../../../src/agents/agents.service";
import { ClassificationRuleEngine } from "../../../src/classification/classification-rule-engine";
import { DataClassificationTagger } from "../../../src/classification/data-classification-tagger";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { PhiAuditEmitter } from "../../../src/phi-scrubber/phi-audit-emitter";
import { PhiQuarantineRepository } from "../../../src/phi-scrubber/phi-quarantine.repository";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { PhiSecondaryValidator } from "../../../src/phi-scrubber/phi-secondary-validator";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import * as fixtures from "./fixtures/autogen-event-payloads";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-autogen-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM phi_quarantine_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

function fakeReq(overrides: Record<string, unknown>) {
  return { headers: {}, method: "POST", originalUrl: "/api/v1/adapters/autogen/telemetry", body: {}, ...overrides } as any;
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const hmacMiddleware = new HmacValidationMiddleware(agentsRepository, encryptionService);

  const phiScrubber = new PhiScrubberService();
  const pipeline = new TelemetryPipelineService(
    pool,
    new TelemetrySchemaValidatorService(),
    new TenantRepository(),
    new DataClassificationTagger(new ClassificationRuleEngine()),
    phiScrubber,
    new KafkaTelemetryProducerService(),
    new TelemetryDeadLetterRepository(pool),
    new MetricsAggregatorService(new MetricsAggregatorRepository(pool)),
    new PhiSecondaryValidator(phiScrubber),
    new PhiAuditEmitter(audit),
    new PhiQuarantineRepository(pool),
  );

  const registry = new AdapterRegistryService();
  registry.register("autogen", new AutoGenAdapter(new AutoGenConnectionValidator()));
  const controller = new AdaptersController(registry, pipeline, pool);

  return { saga, agentsService, hmacMiddleware, controller };
}

test("a full multi-agent GroupChat conversation trace flows through HMAC -> translation -> pipeline, with conversational structure reconstructable from what's persisted", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "AutoGen Adapter Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "AutoGen Test Agent", framework: "autogen", connectionConfig: { configEndpoint: "http://localhost:9999" } });

    async function send(rawBodyObject: unknown): Promise<any> {
      const bodyBuffer = Buffer.from(JSON.stringify(rawBodyObject));
      const signature = createHmac("sha256", Buffer.from(created.hmacSecret, "hex")).update(bodyBuffer).digest("hex");
      const req = fakeReq({ headers: { "x-agent-id": created.id, "x-signature-256": signature }, body: rawBodyObject, rawBody: bodyBuffer });
      await hmacMiddleware.use(req, { status: () => ({ json: () => undefined }) } as any, () => undefined);
      return controller.ingestTelemetry("autogen", rawBodyObject, req);
    }

    const trace = fixtures.fullConversationTrace();
    for (const event of trace) {
      const env = fixtures.envelope(event, { agent_id: created.id, tenant_id: tenant.id });
      const result = await send(env);
      assert.equal(result.accepted, true);
    }

    const dlqRows = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1 ORDER BY created_at", [tenant.id]);
    assert.equal(dlqRows.rows.length, 7, "every event in the trace must be its own canonical event (no Kafka broker in this sandbox, so all 7 land in the DLQ)");

    const groupChatRow = dlqRows.rows.find((r) => r.payload.metadata.groupChatId === "groupchat-001")!;
    assert.deepEqual(groupChatRow.payload.metadata.participants, ["planner", "coder", "reviewer"]);
    assert.equal(groupChatRow.payload.metadata.orchestrator, "group_chat_manager");

    const functionResultRow = dlqRows.rows.find((r) => r.payload.tool_call_name === "search_web" && r.payload.event_type === "metric")!;
    assert.equal(functionResultRow.payload.tool_call_success, true);
    assert.equal(functionResultRow.payload.latency_ms, 1800);

    const nestedStartRow = dlqRows.rows.find((r) => r.payload.metadata.conversationId === "conv-nested-001" && r.payload.event_type === "trace")!;
    assert.equal(nestedStartRow.payload.metadata.parentConversationId, "conv-001");
    assert.equal(nestedStartRow.payload.metadata.nestingLevel, 1);

    const conversationEndRow = dlqRows.rows.find((r) => r.payload.metadata.conversationId === "conv-001" && r.payload.event_type === "metric")!;
    assert.equal(conversationEndRow.payload.latency_ms, 1800);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a function_result failure event's PHI-containing error message is scrubbed before persistence to the dead-letter table", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "AutoGen PHI Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "AutoGen PHI Agent", framework: "autogen", connectionConfig: {} });

    const rawBodyObject = fixtures.envelope(fixtures.FUNCTION_RESULT_FAILURE, { agent_id: created.id, tenant_id: tenant.id });
    const bodyBuffer = Buffer.from(JSON.stringify(rawBodyObject));
    const signature = createHmac("sha256", Buffer.from(created.hmacSecret, "hex")).update(bodyBuffer).digest("hex");
    const req = fakeReq({ headers: { "x-agent-id": created.id, "x-signature-256": signature }, body: rawBodyObject, rawBody: bodyBuffer });
    await hmacMiddleware.use(req, { status: () => ({ json: () => undefined }) } as any, () => undefined);
    await controller.ingestTelemetry("autogen", rawBodyObject, req);

    const dlqRow = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenant.id]);
    const storedError = dlqRow.rows[0].payload.metadata.error as string;
    assert.ok(!storedError.includes("123-45-6789"));
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
