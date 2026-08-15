import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { PG_POOL } from "../../common/database/database.module";
import { ActorType, type CanonicalAuditEvent } from "../events/canonical-audit-event";
import { AuditEventConsumerPipelineService } from "../events/audit-event-consumer-pipeline.service";
import { AuditEventProducerService } from "../events/audit-event-producer.service";
import type { AuditLogFilters } from "../query/audit-log-query.repository";
import { AuditLogQueryRepository } from "../query/audit-log-query.repository";
import { AuditExportJobRepository } from "./audit-export-job.repository";
import { EXPORT_STORAGE_SERVICE, type ExportStoragePort } from "./export-storage.port";

/**
 * WO-047's export background processor. Runs OUTSIDE the HTTP request
 * lifecycle (the controller returns 202 before this even starts), so it
 * cannot reuse `req.tenantDbClient` — that connection is released back
 * to the pool the moment the response finishes. Acquires its own
 * connection and establishes app.current_tenant itself, the same
 * BEGIN/set_config shape AdaptersController (WO-043) uses for its own
 * outside-the-request-context path.
 *
 * There is no real background job queue in this codebase (no BullMQ/
 * SQS/etc. anywhere) — this is invoked directly, fire-and-forget, from
 * AuditExportService right after the job row is created. That's a
 * legitimate choice for THIS sandbox's single-instance deployment, not a
 * simulated stand-in for something that would look different in
 * production the way the Kafka substitutions elsewhere in this codebase
 * are — a real horizontally-scaled deployment would swap this for a
 * proper queue consumer without changing the actual export logic here.
 * See AUDIT_EXPORT_QUERY_API.md.
 */
@Injectable()
export class AuditExportWorkerService {
  private readonly logger = new Logger(AuditExportWorkerService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly queryRepository: AuditLogQueryRepository,
    private readonly jobRepository: AuditExportJobRepository,
    @Inject(EXPORT_STORAGE_SERVICE) private readonly storage: ExportStoragePort,
    private readonly auditProducer: AuditEventProducerService,
    private readonly auditPipeline: AuditEventConsumerPipelineService,
  ) {}

  async run(jobId: string, filters: AuditLogFilters, requestedBy: string | null): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [filters.tenantId]);
      await this.jobRepository.markProcessing(jobId, client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      this.logger.error(`export job ${jobId} failed to transition to processing: ${err instanceof Error ? err.message : err}`);
      return;
    }
    client.release();

    let recordCount = 0;
    try {
      const streamClient = await this.pool.connect();
      await streamClient.query("BEGIN");
      await streamClient.query("SELECT set_config('app.current_tenant', $1, true)", [filters.tenantId]);

      const rows = this.queryRepository.streamByFilters(filters, streamClient);
      const countingRows = (async function* countAndYield() {
        for await (const row of rows) {
          recordCount++;
          yield row as unknown as Record<string, unknown>;
        }
      })();

      const uploaded = await this.storage.uploadNdjson(filters.tenantId, jobId, countingRows);
      await streamClient.query("COMMIT");
      streamClient.release();

      const presigned = await this.storage.getPresignedDownloadUrl(uploaded.storageKey);

      // Recorded BEFORE the job is marked "completed" — a caller polling
      // GET /exports/:id must never observe status:completed while the
      // audit-of-export event (this WO's own AC) is still in flight. A
      // real race found via testing: recording it AFTER meant a test
      // polling for job completion could tear down its Postgres pool
      // while this write was still using it.
      await this.recordExportAudit(filters.tenantId, requestedBy, jobId, recordCount, filters, true, null);

      const completeClient = await this.pool.connect();
      await completeClient.query("BEGIN");
      await completeClient.query("SELECT set_config('app.current_tenant', $1, true)", [filters.tenantId]);
      await this.jobRepository.markCompleted(jobId, recordCount, uploaded.storageKey, presigned.url, presigned.expiresAt, completeClient);
      await completeClient.query("COMMIT");
      completeClient.release();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown export error";
      this.logger.error(`export job ${jobId} failed: ${message}`);
      const failClient = await this.pool.connect();
      await failClient.query("BEGIN");
      await failClient.query("SELECT set_config('app.current_tenant', $1, true)", [filters.tenantId]);
      await this.jobRepository.markFailed(jobId, message, failClient);
      await failClient.query("COMMIT");
      failClient.release();

      await this.recordExportAudit(filters.tenantId, requestedBy, jobId, recordCount, filters, false, message);
    }
  }

  /** AC: "Every export request is itself recorded as an audit event (action: 'audit.exported', with filters used, record count, and requesting actor)." Produces via the SDK (genuine attempt, expected to fail/buffer without a broker — WO-046) AND persists via the in-process pipeline, the same two-step pattern WO-046's own tests establish. */
  private async recordExportAudit(tenantId: string, requestedBy: string | null, jobId: string, recordCount: number, filters: AuditLogFilters, succeeded: boolean, errorMessage: string | null): Promise<void> {
    const event: CanonicalAuditEvent = {
      event_id: randomUUID(),
      actor_id: requestedBy,
      actor_type: requestedBy ? ActorType.USER : ActorType.SYSTEM,
      tenant_id: tenantId,
      action: "audit.exported",
      resource_type: "audit_export_job",
      resource_id: jobId,
      data_classification: "confidential",
      ip_address: null,
      // job_id is already carried as resource_id/correlation_id above —
      // deliberately NOT duplicated into change_details: a raw UUID
      // string, when it goes through the SAME free-text PHI scrub pass
      // as everything else in this JSONB field (WO-017/043/044's
      // PhiScrubberService applies uniformly, with no exemption for
      // "this string happens to be an identifier"), can trip a
      // value-shape pattern on a SUBSTRING of itself (found via testing:
      // a job_id UUID came back from the round trip with several of its
      // hex groups masked, since some of its digit runs happened to
      // match the MRN/DOB patterns). None of the actual fields below are
      // UUID-shaped, so they aren't at risk of the same false-positive.
      change_details: {
        record_count: recordCount,
        succeeded,
        error_message: errorMessage,
        filters: { startTime: filters.startTime.toISOString(), endTime: filters.endTime.toISOString(), actorId: filters.actorId ?? null, action: filters.action ?? null, resourceType: filters.resourceType ?? null },
      },
      correlation_id: jobId,
      occurred_at: new Date().toISOString(),
    };

    await this.auditProducer.publish(event).catch(() => undefined);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      await this.auditPipeline.process(client, event);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.logger.error(`failed to persist audit.exported event for job ${jobId}: ${err instanceof Error ? err.message : err}`);
    } finally {
      client.release();
    }
  }
}
