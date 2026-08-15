import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AdapterRegistryService } from "../../src/adapters/adapter-registry.service";
import { AdaptersController } from "../../src/adapters/adapters.controller";
import { BaseAgentAdapter } from "../../src/adapters/base-agent-adapter";
import { HmacValidationMiddleware } from "../../src/adapters/hmac-validation.middleware";
import { KafkaTelemetryProducerService } from "../../src/adapters/kafka/kafka-telemetry-producer.service";
import { TelemetryDeadLetterRepository } from "../../src/adapters/kafka/telemetry-dead-letter.repository";
import { TelemetryPipelineService } from "../../src/adapters/pipeline/telemetry-pipeline.service";
import { TelemetrySchemaValidatorService } from "../../src/adapters/telemetry-schema-validator.service";
import type { AdapterMetadata, ConnectionValidationResult } from "../../src/adapters/interfaces/agent-adapter.interface";
import type { CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";
import { DataClassificationTagger } from "../../src/classification/data-classification-tagger";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-adapters-${Math.random().toString(36).slice(2, 8)}`;
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

/**
 * A minimal, test-only IAgentAdapter — NOT a production framework
 * adapter (those are WO-035/036/037/038's own scope). Its
 * translateTelemetry is intentionally near-identity since this test's
 * raw event is already canonical-shaped; it exists purely so this WO's
 * own "integration test validates the full pipeline" AC has a real
 * concrete adapter to route through, without preempting WO-036's generic
 * REST adapter work.
 */
class ReferenceTestAdapter extends BaseAgentAdapter {
  constructor() {
    super();
  }

  async validateConnection(_config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    return { valid: true };
  }

  translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent {
    return rawEvent as CanonicalTelemetryEvent;
  }

  getAdapterMetadata(): AdapterMetadata {
    return { frameworkType: "generic_rest", adapterVersion: "reference-test-1.0.0", supportedEventTypes: [] };
  }
}

function fakeReq(overrides: Record<string, unknown>) {
  return { headers: {}, method: "POST", originalUrl: "/api/v1/adapters/generic_rest/telemetry", body: {}, ...overrides } as any;
}

function fakeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return { status(code: number) { state.statusCode = code; return this; }, json(body: unknown) { state.body = body; return this; }, state } as any;
}

async function buildRig(pool: Pool) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const hmacMiddleware = new HmacValidationMiddleware(agentsRepository, encryptionService);

  const schemaValidator = new TelemetrySchemaValidatorService();
  const tenantRepository = new TenantRepository();
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());
  const phiScrubber = new PhiScrubberService();
  // Real KafkaJS producer against a broker that doesn't exist in this
  // sandbox (no Docker/local Kafka — confirmed via a direct connection
  // probe) — publish() genuinely fails here, exercising the real
  // dead-letter fallback path rather than a mocked one.
  const kafkaProducer = new KafkaTelemetryProducerService();
  const deadLetterRepository = new TelemetryDeadLetterRepository(pool);
  const pipeline = new TelemetryPipelineService(pool, schemaValidator, tenantRepository, tagger, phiScrubber, kafkaProducer, deadLetterRepository);

  const registry = new AdapterRegistryService();
  registry.register("generic_rest", new ReferenceTestAdapter());
  const controller = new AdaptersController(registry, pipeline);

  return { saga, agentsService, hmacMiddleware, controller, deadLetterRepository, kafkaProducer };
}

test("full pipeline: HMAC validation -> schema validation -> enrichment -> PHI scrub -> Kafka publish attempt -> dead-letter fallback", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware, controller, deadLetterRepository, kafkaProducer } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "Adapter Pipeline Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "Telemetry Test Agent", framework: "generic_rest", connectionConfig: {} });
    assert.ok(created.hmacSecret, "create() must reveal the raw HMAC secret exactly once");

    const rawEvent: CanonicalTelemetryEvent = {
      event_id: randomUUID(),
      agent_id: created.id,
      tenant_id: tenant.id,
      timestamp: new Date().toISOString(),
      event_type: "trace" as any,
      latency_ms: 88,
      error_rate: 0,
      token_consumption: 120,
      tool_call_success: true,
      tool_call_name: "lookup_record",
      framework_type: "generic_rest",
      adapter_version: "1.0.0",
      raw_payload_hash: "a".repeat(64),
      metadata: { patient_ssn: "123-45-6789", note: "routine check-in" },
    };
    const bodyBuffer = Buffer.from(JSON.stringify(rawEvent));
    const secret = Buffer.from(created.hmacSecret, "hex");
    const signature = createHmac("sha256", secret).update(bodyBuffer).digest("hex");

    // Step 1: HMAC validation, exactly as HmacValidationMiddleware would run for a real request.
    const req = fakeReq({ headers: { "x-agent-id": created.id, "x-signature-256": signature }, body: rawEvent, rawBody: bodyBuffer });
    const res = fakeRes();
    let authenticated = false;
    await hmacMiddleware.use(req, res, () => {
      authenticated = true;
    });
    assert.equal(authenticated, true, "a correctly signed request must pass HMAC validation");
    assert.equal(req.tenantId, tenant.id);
    assert.equal(req.telemetryAgentId, created.id);

    // Step 2: the full ingestion controller — adapter lookup, translation, and the rest of the pipeline.
    const result: any = await controller.ingestTelemetry("generic_rest", rawEvent, req);
    assert.equal(result.accepted, true);
    assert.equal(result.eventId, rawEvent.event_id);
    assert.equal(result.deadLettered, true, "no Kafka broker exists in this sandbox — publication genuinely fails and falls back to the DLQ");

    // Step 3: verify what actually landed in Postgres — genuinely scrubbed, genuinely durable.
    const dlqRows = await deadLetterRepository.findByTenant(pool, tenant.id);
    assert.equal(dlqRows.length, 1);
    assert.equal(dlqRows[0].event_id, rawEvent.event_id);

    const rawRow = await pool.query("SELECT payload FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenant.id]);
    const storedPayload = rawRow.rows[0].payload;
    assert.notEqual(storedPayload.metadata.patient_ssn, "123-45-6789", "PHI must be scrubbed before it's even written to the dead-letter table");
    assert.equal(storedPayload.metadata.note, "routine check-in");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
    await kafkaProducer.onModuleDestroy();
  }
});

test("HMAC validation rejects a telemetry request signed with the wrong agent's secret", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, hmacMiddleware } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "Adapter Wrong Secret Co", slug, dataResidencyRegion: "us", actorId: null });
    const agentA = await agentsService.create(pool, tenant.id, null, { name: "Agent A", framework: "generic_rest", connectionConfig: {} });
    const agentB = await agentsService.create(pool, tenant.id, null, { name: "Agent B", framework: "generic_rest", connectionConfig: {} });

    const body = { hello: "world" };
    const bodyBuffer = Buffer.from(JSON.stringify(body));
    // Signed with Agent B's secret but claiming to be Agent A.
    const signature = createHmac("sha256", Buffer.from(agentB.hmacSecret, "hex")).update(bodyBuffer).digest("hex");

    const req = fakeReq({ headers: { "x-agent-id": agentA.id, "x-signature-256": signature }, body, rawBody: bodyBuffer });
    const res = fakeRes();
    let authenticated = false;
    await hmacMiddleware.use(req, res, () => {
      authenticated = true;
    });

    assert.equal(authenticated, false);
    assert.equal(res.state.statusCode, 401);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("the ingestion controller rejects an event whose agent_id/tenant_id doesn't match the HMAC-authenticated identity", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const { saga, agentsService, controller, kafkaProducer } = await buildRig(pool);

  try {
    const tenant = await saga.provision({ name: "Adapter Mismatch Co", slug, dataResidencyRegion: "us", actorId: null });
    const created = await agentsService.create(pool, tenant.id, null, { name: "Mismatch Agent", framework: "generic_rest", connectionConfig: {} });

    const forgedEvent: CanonicalTelemetryEvent = {
      event_id: randomUUID(),
      agent_id: randomUUID(), // claims to be a DIFFERENT agent than the one that authenticated
      tenant_id: tenant.id,
      timestamp: new Date().toISOString(),
      event_type: "heartbeat" as any,
      latency_ms: null,
      error_rate: null,
      token_consumption: null,
      tool_call_success: null,
      tool_call_name: null,
      framework_type: "generic_rest",
      adapter_version: "1.0.0",
      raw_payload_hash: "a".repeat(64),
      metadata: {},
    };
    const req = fakeReq({ telemetryAgentId: created.id, tenantId: tenant.id });

    await assert.rejects(
      () => controller.ingestTelemetry("generic_rest", forgedEvent, req),
      (err: any) => {
        assert.equal(err.getStatus(), 403);
        return true;
      },
    );
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
    await kafkaProducer.onModuleDestroy();
  }
});

test("the ingestion controller returns 404 for an unregistered framework type", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { controller, kafkaProducer } = await buildRig(pool);

  try {
    await assert.rejects(
      () => controller.ingestTelemetry("unknown_framework", {}, fakeReq({})),
      (err: any) => {
        assert.equal(err.getStatus(), 404);
        return true;
      },
    );
  } finally {
    await pool.end();
    await kafkaProducer.onModuleDestroy();
  }
});
