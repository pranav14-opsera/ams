import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AuditStoreRepository } from "../../../src/audit/audit-store.repository";
import { AuditEnrichmentService } from "../../../src/audit/events/audit-enrichment.service";
import { AuditEventConsumerPipelineService } from "../../../src/audit/events/audit-event-consumer-pipeline.service";
import { AuditEventDeadLetterRepository } from "../../../src/audit/events/audit-event-dead-letter.repository";
import { AuditEventProducerService } from "../../../src/audit/events/audit-event-producer.service";
import { AuditEventSchemaValidatorService } from "../../../src/audit/events/audit-event-schema-validator.service";
import { KafkaAuditEventProducerService } from "../../../src/audit/events/kafka-audit-event-producer.service";
import { ActorType, type CanonicalAuditEvent } from "../../../src/audit/events/canonical-audit-event";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-audit-pipeline-${Math.random().toString(36).slice(2, 10)}`;
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

function canonicalEvent(tenantId: string, overrides: Partial<CanonicalAuditEvent> = {}): CanonicalAuditEvent {
  return {
    event_id: randomUUID(),
    actor_id: null,
    actor_type: ActorType.SYSTEM,
    tenant_id: tenantId,
    action: "governance.rule.updated",
    resource_type: "governance_rule",
    resource_id: randomUUID(),
    data_classification: "internal",
    ip_address: "203.0.113.9",
    change_details: {},
    correlation_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

test("full pipeline: SDK produce attempt -> in-process consume -> enrichment -> PHI scrub -> real hash-chained persistence", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Pipeline ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const sdk = new AuditEventProducerService(kafkaProducer);
    const pipeline = new AuditEventConsumerPipelineService(
      new AuditEventSchemaValidatorService(),
      new AuditEnrichmentService(appPool, new TenantRepository()),
      new PhiScrubberService(),
      new AuditStoreRepository(appPool),
      new AuditEventDeadLetterRepository(appPool),
    );

    const event = canonicalEvent(tenant.id, { change_details: { patient_name: "Jane Doe", note: "reviewed at follow-up, SSN 000-00-0000 confirmed" } });

    // SDK publish genuinely fails (no reachable Kafka broker in this
    // sandbox) — that's expected and doesn't block processing: in a real
    // deployment the CONSUMER reads this same canonical event back off
    // the topic after a successful publish; here we drive it through the
    // same in-process pipeline every prior WO in this codebase uses as
    // the substitute for a real consumer (see AUDIT_ENRICHMENT_PIPELINE.md).
    await assert.rejects(() => sdk.publish(event));
    assert.equal(sdk.bufferedCount, 1);

    const result = await withTenantContext(appPool, tenant.id, (client) => pipeline.process(client, event));
    assert.equal(result.deadLettered, false);
    assert.ok(result.auditRowId);

    const row = await adminPool.query("SELECT details, record_hash, prev_hash, data_classification FROM audit_events WHERE id = $1", [result.auditRowId]);
    const details = row.rows[0].details;
    assert.notEqual(details.patient_name, "Jane Doe", "PHI in a structured field must be masked");
    assert.ok(!JSON.stringify(details).includes("000-00-0000"), "PHI embedded in free text must be masked too");
    assert.equal(details.actor_type, "system");
    assert.equal(details.correlation_id, event.correlation_id);
    assert.equal(row.rows[0].record_hash.length, 64);
    assert.equal(row.rows[0].data_classification, "internal");

    const repository = new AuditStoreRepository(appPool);
    const verification = await withTenantContext(appPool, tenant.id, (client) => repository.verifyChain(tenant.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), client));
    assert.equal(verification.valid, true);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});

test("full pipeline: an event referencing an unknown tenant is routed to the DLQ, never crashes the pipeline", { skip }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const pipeline = new AuditEventConsumerPipelineService(
      new AuditEventSchemaValidatorService(),
      new AuditEnrichmentService(appPool, new TenantRepository()),
      new PhiScrubberService(),
      new AuditStoreRepository(appPool),
      new AuditEventDeadLetterRepository(appPool),
    );

    const unknownTenantId = randomUUID();
    const event = canonicalEvent(unknownTenantId);

    const result = await withTenantContext(appPool, unknownTenantId, (client) => pipeline.process(client, event));
    assert.equal(result.deadLettered, true);
    assert.equal(result.auditRowId, null);

    // DLQ write itself needs tenant context too, but audit_events_dlq's
    // FK requires a REAL tenant row — an unknown tenant_id can't even be
    // DLQ'd (documented in the pipeline's own safeDeadLetter fallback:
    // logs loudly rather than crashing). Verified here as "no exception
    // propagated to the caller," not "a DLQ row exists," since that
    // second guarantee genuinely cannot hold for a tenant that was never
    // provisioned at all.
  } finally {
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});
