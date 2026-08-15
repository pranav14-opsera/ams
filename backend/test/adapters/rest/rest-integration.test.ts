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
import { MetricsAggregatorRepository } from "../../../src/adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorService } from "../../../src/adapters/metrics/metrics-aggregator.service";
import { TelemetryPipelineService } from "../../../src/adapters/pipeline/telemetry-pipeline.service";
import { GenericRestAdapter } from "../../../src/adapters/rest/rest-adapter";
import { RestConnectionValidator } from "../../../src/adapters/rest/rest-connection-validator";
import { RestTelemetryValidatorService } from "../../../src/adapters/rest/rest-telemetry-validator.service";
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

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-rest-${Math.random().toString(36).slice(2, 8)}`;
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
  return { headers: {}, method: "POST", originalUrl: "/api/v1/adapters/generic_rest/telemetry", body: {}, ...overrides } as any;
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
  registry.register("generic_rest", new GenericRestAdapter(new RestConnectionValidator(), new RestTelemetryValidatorService()));
  const controller = new AdaptersController(registry, pipeline, pool);

  return { saga, agentsService, hmacMiddleware, controller };
}

async function authenticatedSend(hmacMiddleware: HmacValidationMiddleware, controller: AdaptersController, agentId: string, hmacSecretHex: string, body: unknown): Promise<any> {
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  const signature = createHmac("sha256", Buffer.from(hmacSecretHex, "hex")).update(bodyBuffer).digest("hex");
  const req = fakeReq({ headers: { "x-agent-id": agentId, "x-signature-256": signature }, body, rawBody: bodyBuffer });
  await hmacMiddleware.use(req, { status: () => ({ json: () => undefined }) } as any, () => undefined);
  return controller.ingestTelemetry("generic_rest", body, req);
}

test("a single REST telemetry event flows through HMAC -> translation -> schema validation -> PHI scrub -> dead-letter fallback", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "REST Adapter Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "REST Test Agent", framework: "generic_rest", connectionConfig: { healthEndpoint: "http://localhost:9999" } });

    const event = { agent_id: created.id, tenant_id: tenant.id, event_type: "metric", duration_ms: 75, tokens: 40, metadata: { patient_ssn: "111-22-3333" } };
    const result = await authenticatedSend(hmacMiddleware, controller, created.id, created.hmacSecret, event);

    assert.equal(result.accepted, true);
    assert.equal(result.deadLettered, true);

    const dlqRow = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenant.id]);
    assert.equal(dlqRow.rows[0].payload.latency_ms, 75);
    assert.equal(dlqRow.rows[0].payload.token_consumption, 40);
    assert.notEqual(dlqRow.rows[0].payload.metadata.patient_ssn, "111-22-3333");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a batch submission processes every event independently, with mixed valid/invalid results and per-agent audit/dlq records", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "REST Batch Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "REST Batch Agent", framework: "generic_rest", connectionConfig: {} });

    const batch = [
      { agent_id: created.id, tenant_id: tenant.id, event_type: "metric", latency_ms: 10 },
      { agent_id: created.id, tenant_id: tenant.id, event_type: "not_a_real_type" }, // invalid: schema validation failure
      { agent_id: created.id, tenant_id: tenant.id, event_type: "heartbeat" },
      { agent_id: "some-other-agent-id", tenant_id: tenant.id, event_type: "metric" }, // invalid: agent_id mismatch (403)
    ];

    const result = await authenticatedSend(hmacMiddleware, controller, created.id, created.hmacSecret, batch);

    assert.equal(result.totalCount, 4);
    assert.equal(result.acceptedCount, 2);
    assert.equal(result.rejectedCount, 2);
    assert.equal(result.results[0].status, "accepted");
    assert.equal(result.results[1].status, "rejected");
    assert.equal(result.results[2].status, "accepted");
    assert.equal(result.results[3].status, "rejected");

    const dlqRows = await pool.query("SELECT id FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenant.id]);
    assert.equal(dlqRows.rows.length, 2, "only the 2 successfully-validated events reach the pipeline/DLQ");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("a batch exceeding the 100-event max is rejected with 400 before any event is processed", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "REST Overflow Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "REST Overflow Agent", framework: "generic_rest", connectionConfig: {} });

    const oversizedBatch = Array.from({ length: 101 }, () => ({ agent_id: created.id, tenant_id: tenant.id, event_type: "heartbeat" }));

    await assert.rejects(
      () => authenticatedSend(hmacMiddleware, controller, created.id, created.hmacSecret, oversizedBatch),
      (err: any) => {
        assert.equal(err.getStatus(), 400);
        return true;
      },
    );

    const dlqRows = await pool.query("SELECT id FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenant.id]);
    assert.equal(dlqRows.rows.length, 0, "no event from a rejected oversized batch should be processed");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
