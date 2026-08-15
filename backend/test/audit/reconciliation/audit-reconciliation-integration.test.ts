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
import { AuditDeepSampleService } from "../../../src/audit/reconciliation/audit-deep-sample.service";
import { AuditIngestionCounterRepository } from "../../../src/audit/reconciliation/audit-ingestion-counter.repository";
import { AuditReconciliationReportRepository } from "../../../src/audit/reconciliation/audit-reconciliation-report.repository";
import { AuditReconciliationService } from "../../../src/audit/reconciliation/audit-reconciliation.service";
import { AuditReplayService } from "../../../src/audit/reconciliation/audit-replay.service";
import { ColdStorageManifestRepository } from "../../../src/audit/retention/cold-storage-manifest.repository";
import { LocalFilesystemColdStorageService } from "../../../src/audit/retention/local-filesystem-cold-storage.service";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-audit-recon-${Math.random().toString(36).slice(2, 10)}`;
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
  await adminPool.query("DELETE FROM audit_reconciliation_reports WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM audit_ingestion_counters WHERE tenant_id = $1", [tenantId]);
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

async function provisionTenant(adminPool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const audit = new PostgresAuditService(adminPool);
  const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
  return saga.provision({ name: `Audit Recon ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
}

function buildPipeline(appPool: Pool) {
  const phiScrubber = new PhiScrubberService();
  const storeRepository = new AuditStoreRepository(appPool);
  return new AuditEventConsumerPipelineService(
    new AuditEventSchemaValidatorService(),
    new AuditEnrichmentService(appPool, new TenantRepository()),
    phiScrubber,
    storeRepository,
    new AuditEventDeadLetterRepository(appPool),
    new AuditIngestionCounterRepository(appPool),
  );
}

test("daily reconciliation: a known gap (5 events attempted but never persisted or DLQ'd) is detected and a P1 alert is triggered with correct gap details", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const tenant = await provisionTenant(adminPool, slug);
    const counterRepository = new AuditIngestionCounterRepository(appPool);
    const storeRepository = new AuditStoreRepository(appPool);
    const reportRepository = new AuditReconciliationReportRepository(appPool);
    const producer = new AuditEventProducerService(kafkaProducer);
    const pipeline = buildPipeline(appPool);
    const manifestRepository = new ColdStorageManifestRepository(appPool);
    const coldStorage = new LocalFilesystemColdStorageService();
    const service = new AuditReconciliationService(appPool, counterRepository, reportRepository, producer, pipeline, manifestRepository, coldStorage);

    const now = new Date();
    const periodStart = new Date(now.getTime() - 60_000);
    const periodEnd = new Date(now.getTime() + 60_000);

    await withTenantContext(appPool, tenant.id, async (client) => {
      // 15 genuinely persisted events (this tenant ALSO already has one
      // real "tenant.provisioned" audit row from saga.provision() above,
      // written via the older AuditServicePort path that predates this
      // WO's ingestion counter — see AUDIT_RECONCILIATION.md for why
      // that path isn't counted as an "attempt" here). Counting the
      // ACTUAL persisted total first (rather than assuming it's exactly
      // 15) keeps this test correct regardless of that coexisting row.
      for (let i = 0; i < 15; i++) {
        await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "test.action", resourceType: "test_resource", resourceId: randomUUID(), details: {} }, client, now);
      }
    });

    const actualPersistedTotal = await adminPool.query("SELECT count(*)::int AS c FROM audit_events WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at <= $3", [tenant.id, periodStart.toISOString(), periodEnd.toISOString()]);
    const persistedCount = actualPersistedTotal.rows[0].c;

    // 5 "attempts" that count toward "expected" but were NEVER written
    // anywhere (the literal AC scenario — "skip 5 events" — simulating a
    // crash between attempt and persistence/DLQ, which is exactly what
    // this reconciliation exists to catch), on top of one "attempt" per
    // genuinely persisted event.
    await withTenantContext(appPool, tenant.id, async (client) => {
      for (let i = 0; i < persistedCount + 5; i++) {
        await counterRepository.increment(tenant.id, now, client);
      }
    });

    const report = await service.runDailyReconciliation(tenant.id, periodStart, periodEnd, 0.1);

    assert.equal(report.status, "discrepancy_detected");
    assert.equal(report.alertTriggered, true);
    assert.equal(report.expectedCount, persistedCount + 5);
    assert.equal(report.actualCount, persistedCount);
    assert.equal(report.gapCount, 5);
    assert.ok(Math.abs(report.gapPercentage - (5 / (persistedCount + 5)) * 100) < 0.0001);

    // The alert itself is durably queryable.
    const reports = await withTenantContext(appPool, tenant.id, (client) => reportRepository.findByTenant(tenant.id, { reportType: "daily_reconciliation" }, client));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].alertTriggered, true);

    // The alert produced its own real audit_events row.
    const alertAuditRow = await adminPool.query("SELECT action, details FROM audit_events WHERE tenant_id = $1 AND action = 'reconciliation.gap_detected'", [tenant.id]);
    assert.equal(alertAuditRow.rows.length, 1);
    assert.equal(alertAuditRow.rows[0].details.gap_count, 5);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});

test("monthly deep-sample: an intentionally corrupted record's hash mismatch is detected and a P1 alert is triggered", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const tenant = await provisionTenant(adminPool, slug);
    const storeRepository = new AuditStoreRepository(appPool);
    const reportRepository = new AuditReconciliationReportRepository(appPool);
    const producer = new AuditEventProducerService(kafkaProducer);
    const pipeline = buildPipeline(appPool);
    const deepSampleService = new AuditDeepSampleService(appPool, reportRepository, producer, pipeline);

    const now = new Date();
    const insertedIds: string[] = [];
    await withTenantContext(appPool, tenant.id, async (client) => {
      for (let i = 0; i < 10; i++) {
        const inserted = await storeRepository.insertAuditEvent(
          { tenantId: tenant.id, actorId: null, action: "test.action", resourceType: "test_resource", resourceId: randomUUID(), details: { i } },
          client,
          new Date(now.getTime() + i * 1000),
        );
        insertedIds.push(inserted.id);
      }
    });

    // Simulate tampering directly at the storage layer (application code
    // can never do this — UPDATE is revoked, WO-045) to prove the
    // deep-sample genuinely recomputes and compares, rather than trusting
    // the stored hash.
    const tamperedId = insertedIds[3];
    await adminPool.query("UPDATE audit_events SET details = '{\"tampered\": true}'::jsonb WHERE id = $1", [tamperedId]);

    const periodStart = new Date(now.getTime() - 60_000);
    const periodEnd = new Date(now.getTime() + 60_000);
    // sampleSize = 10 (the total row count) guarantees the tampered row
    // is included, since this test's own point is to prove the CHECK
    // works, not to prove random sampling itself.
    const report = await deepSampleService.runMonthlyDeepSample(tenant.id, periodStart, periodEnd, 1000);

    assert.equal(report.status, "discrepancy_detected");
    assert.equal(report.alertTriggered, true);
    assert.equal(report.gapCount, 1);
    const failures = (report.details as any).failures;
    assert.ok(failures.some((f: any) => f.eventId === tamperedId));

    const alertAuditRow = await adminPool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'reconciliation.deep_sample_failure'", [tenant.id]);
    assert.equal(alertAuditRow.rows.length, 1);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});

test("monthly deep-sample: an untampered dataset reports healthy with zero failures", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const tenant = await provisionTenant(adminPool, slug);
    const storeRepository = new AuditStoreRepository(appPool);
    const reportRepository = new AuditReconciliationReportRepository(appPool);
    const producer = new AuditEventProducerService(kafkaProducer);
    const pipeline = buildPipeline(appPool);
    const deepSampleService = new AuditDeepSampleService(appPool, reportRepository, producer, pipeline);

    const now = new Date();
    await withTenantContext(appPool, tenant.id, async (client) => {
      for (let i = 0; i < 5; i++) {
        await storeRepository.insertAuditEvent({ tenantId: tenant.id, actorId: null, action: "test.action", resourceType: "test_resource", resourceId: randomUUID(), details: { i } }, client, new Date(now.getTime() + i * 1000));
      }
    });

    const report = await deepSampleService.runMonthlyDeepSample(tenant.id, new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000), 1000);
    assert.equal(report.status, "healthy");
    assert.equal(report.alertTriggered, false);
    assert.equal(report.gapCount, 0);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});

test("replay: a DLQ'd event is recovered into audit_events and removed from the DLQ", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const tenant = await provisionTenant(adminPool, slug);
    const deadLetterRepository = new AuditEventDeadLetterRepository(appPool);
    const pipeline = buildPipeline(appPool);
    const replayService = new AuditReplayService(appPool, pipeline);

    const now = new Date();
    const event: CanonicalAuditEvent = {
      event_id: randomUUID(),
      actor_id: null,
      actor_type: ActorType.SYSTEM,
      tenant_id: tenant.id,
      action: "test.replay.action",
      resource_type: "test_resource",
      resource_id: randomUUID(),
      data_classification: "internal",
      ip_address: null,
      change_details: {},
      correlation_id: null,
      occurred_at: now.toISOString(),
    };

    await withTenantContext(appPool, tenant.id, (client) => deadLetterRepository.record(client, event, "simulated original failure"));

    const dlqBefore = await withTenantContext(appPool, tenant.id, (client) => deadLetterRepository.findByTenant(client, tenant.id));
    assert.equal(dlqBefore.length, 1);

    const result = await replayService.replayFromDeadLetterQueue(tenant.id, new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    assert.equal(result.attempted, 1);
    assert.equal(result.recovered, 1);
    assert.equal(result.stillFailing, 0);

    const dlqAfter = await withTenantContext(appPool, tenant.id, (client) => deadLetterRepository.findByTenant(client, tenant.id));
    assert.equal(dlqAfter.length, 0, "a successfully replayed event must be removed from the DLQ");

    const persisted = await adminPool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'test.replay.action'", [tenant.id]);
    assert.equal(persisted.rows.length, 1);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});
