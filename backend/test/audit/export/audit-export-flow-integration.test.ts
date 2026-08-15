import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { AuditStoreRepository } from "../../../src/audit/audit-store.repository";
import { AuditExportJobRepository } from "../../../src/audit/export/audit-export-job.repository";
import { AuditExportService } from "../../../src/audit/export/audit-export.service";
import { AuditExportWorkerService } from "../../../src/audit/export/audit-export-worker.service";
import { LocalFilesystemExportStorageService } from "../../../src/audit/export/local-filesystem-export-storage.service";
import { AuditEnrichmentService } from "../../../src/audit/events/audit-enrichment.service";
import { AuditEventConsumerPipelineService } from "../../../src/audit/events/audit-event-consumer-pipeline.service";
import { AuditEventDeadLetterRepository } from "../../../src/audit/events/audit-event-dead-letter.repository";
import { AuditIngestionCounterRepository } from "../../../src/audit/reconciliation/audit-ingestion-counter.repository";
import { AuditEventProducerService } from "../../../src/audit/events/audit-event-producer.service";
import { AuditEventSchemaValidatorService } from "../../../src/audit/events/audit-event-schema-validator.service";
import { KafkaAuditEventProducerService } from "../../../src/audit/events/kafka-audit-event-producer.service";
import { AuditLogQueryRepository } from "../../../src/audit/query/audit-log-query.repository";
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
  return `test-audit-export-${Math.random().toString(36).slice(2, 10)}`;
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
  await adminPool.query("DELETE FROM audit_export_jobs WHERE tenant_id = $1", [tenantId]);
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

async function waitForJobCompletion(pool: Pool, jobRepository: AuditExportJobRepository, tenantId: string, jobId: string, timeoutMs = 10_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const job = await withTenantContext(pool, tenantId, (client) => jobRepository.findById(tenantId, jobId, client));
    if (job && (job.status === "completed" || job.status === "failed")) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`export job ${jobId} did not finish within ${timeoutMs}ms (last status: ${job?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("full export flow: request -> background worker streams+uploads+completes -> job status reflects a real downloadable file -> audit.exported is persisted", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Export ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const storeRepository = new AuditStoreRepository(appPool);
    const base = new Date();
    await withTenantContext(appPool, tenant.id, async (client) => {
      for (let i = 0; i < 8; i++) {
        await storeRepository.insertAuditEvent(
          { tenantId: tenant.id, actorId: null, action: "user.login", resourceType: "test_resource", resourceId: "00000000-0000-0000-0000-000000000000", details: { i } },
          client,
          new Date(base.getTime() + i * 1000),
        );
      }
    });

    const jobRepository = new AuditExportJobRepository(appPool);
    const storage = new LocalFilesystemExportStorageService();
    const queryRepository = new AuditLogQueryRepository(appPool);
    const phiScrubber = new PhiScrubberService();
    const producer = new AuditEventProducerService(kafkaProducer);
    const pipeline = new AuditEventConsumerPipelineService(
      new AuditEventSchemaValidatorService(),
      new AuditEnrichmentService(appPool, new TenantRepository()),
      phiScrubber,
      storeRepository,
      new AuditEventDeadLetterRepository(appPool),
      new AuditIngestionCounterRepository(appPool),
    );
    const worker = new AuditExportWorkerService(appPool, queryRepository, jobRepository, storage, producer, pipeline);
    const exportService = new AuditExportService(jobRepository, worker);

    const job = await withTenantContext(appPool, tenant.id, (client) =>
      exportService.requestExport(
        tenant.id,
        null as any, // no real users row to reference in this test — requested_by is nullable (SET NULL on delete)
        { startTime: new Date(base.getTime() - 60_000).toISOString(), endTime: new Date(base.getTime() + 60_000).toISOString(), resourceType: "test_resource" },
        client,
      ),
    );

    assert.equal(job.status, "pending");

    const completedJob = await waitForJobCompletion(appPool, jobRepository, tenant.id, job.id);
    assert.equal(completedJob.status, "completed", JSON.stringify(completedJob));
    assert.equal(completedJob.recordCount, 8);
    assert.ok(completedJob.downloadUrl);
    assert.ok(completedJob.downloadUrlExpiresAt);

    assert.ok(storage.verifyPresignedUrl(completedJob.downloadUrl));

    const fileContent = readFileSync(completedJob.storageKey!, "utf8");
    const lines = fileContent.trim().split("\n");
    assert.equal(lines.length, 8, "the exported file must contain exactly the matching rows");
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.action, "user.login");

    // AC: "Every export request is itself recorded as an audit event
    // (action: 'audit.exported', ...)" — verify it landed in audit_events,
    // not just that the worker THINKS it emitted one.
    const exportedAuditRow = await adminPool.query("SELECT action, resource_id, details FROM audit_events WHERE tenant_id = $1 AND action = 'audit.exported'", [tenant.id]);
    assert.equal(exportedAuditRow.rows.length, 1);
    assert.equal(exportedAuditRow.rows[0].details.record_count, 8);
    assert.equal(exportedAuditRow.rows[0].resource_id, job.id);

    await storage.deleteExport(completedJob.storageKey!);
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});

test("requesting more than the concurrent export limit (5) for one tenant is rejected", { skip, timeout: 30_000 }, async () => {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  const appPool = amsAppPool();
  const slug = randomSlug();
  const kafkaProducer = new KafkaAuditEventProducerService();

  try {
    const kms = new InMemoryKmsService();
    const audit = new PostgresAuditService(adminPool);
    const saga = new TenantProvisioningSaga(adminPool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(adminPool), audit);
    const tenant = await saga.provision({ name: `Audit Export Limit ${slug}`, slug, dataResidencyRegion: "us", actorId: null });

    const jobRepository = new AuditExportJobRepository(appPool);
    // 5 pre-existing pending jobs, inserted directly (bypassing the
    // worker entirely) so this test only exercises the concurrency-limit
    // check itself, not the full async pipeline.
    await withTenantContext(appPool, tenant.id, async (client) => {
      for (let i = 0; i < 5; i++) {
        await jobRepository.create(tenant.id, null, { startTime: "2026-01-01", endTime: "2026-01-02" }, client);
      }
    });

    const storage = new LocalFilesystemExportStorageService();
    const storeRepository = new AuditStoreRepository(appPool);
    const queryRepository = new AuditLogQueryRepository(appPool);
    const phiScrubber = new PhiScrubberService();
    const producer = new AuditEventProducerService(kafkaProducer);
    const pipeline = new AuditEventConsumerPipelineService(
      new AuditEventSchemaValidatorService(),
      new AuditEnrichmentService(appPool, new TenantRepository()),
      phiScrubber,
      storeRepository,
      new AuditEventDeadLetterRepository(appPool),
      new AuditIngestionCounterRepository(appPool),
    );
    const worker = new AuditExportWorkerService(appPool, queryRepository, jobRepository, storage, producer, pipeline);
    const exportService = new AuditExportService(jobRepository, worker);

    await assert.rejects(
      () => withTenantContext(appPool, tenant.id, (client) => exportService.requestExport(tenant.id, null as any, { startTime: "2026-01-01", endTime: "2026-01-02" }, client)),
      /maximum concurrent limit is 5/,
    );
  } finally {
    await cleanupTenant(adminPool, slug);
    await adminPool.end();
    await appPool.end();
    await kafkaProducer.onModuleDestroy();
  }
});
