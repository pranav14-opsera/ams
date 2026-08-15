import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { ActorType, type CanonicalAuditEvent } from "../events/canonical-audit-event";
import { AuditEventConsumerPipelineService } from "../events/audit-event-consumer-pipeline.service";
import { AuditEventProducerService } from "../events/audit-event-producer.service";
import { AuditReconciliationReportRepository } from "./audit-reconciliation-report.repository";
import type { ReconciliationReport } from "./audit-reconciliation-report.repository";

const DEFAULT_SAMPLE_SIZE = 1000; // AC: "1,000 random events"
const REQUIRED_FIELDS = ["action", "resource_type", "data_classification", "record_hash"] as const;

export interface DeepSampleFailure {
  eventId: string;
  reason: string;
}

/**
 * WO-048's monthly deep-sample audit: a random sample (not a contiguous
 * range like verify_audit_chain) checked for (1) required-field
 * completeness and (2) hash CONTENT integrity — recomputed server-side
 * via verify_audit_event_hash (migration 042), which reuses the exact
 * same digest formula the write-side trigger uses, rather than
 * recomputing in application code (which would need to exactly reproduce
 * Postgres's own JSONB-to-text serialization rules).
 */
@Injectable()
export class AuditDeepSampleService {
  private readonly logger = new Logger(AuditDeepSampleService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly reportRepository: AuditReconciliationReportRepository,
    private readonly auditProducer: AuditEventProducerService,
    private readonly auditPipeline: AuditEventConsumerPipelineService,
  ) {}

  async runMonthlyDeepSample(tenantId: string, periodStart: Date, periodEnd: Date, sampleSize = DEFAULT_SAMPLE_SIZE): Promise<ReconciliationReport> {
    const client = await this.pool.connect();
    let sampledIds: string[];
    const failures: DeepSampleFailure[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

      const sampled = await client.query(
        `SELECT id, action, resource_type, data_classification, record_hash
         FROM audit_events
         WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at <= $3
         ORDER BY random()
         LIMIT $4`,
        [tenantId, periodStart.toISOString(), periodEnd.toISOString(), sampleSize],
      );
      sampledIds = sampled.rows.map((r) => r.id);

      for (const row of sampled.rows) {
        for (const field of REQUIRED_FIELDS) {
          if (row[field] === null || row[field] === undefined) {
            failures.push({ eventId: row.id, reason: `missing required field "${field}"` });
          }
        }
      }

      for (const id of sampledIds) {
        const verification = await client.query("SELECT * FROM verify_audit_event_hash($1)", [id]);
        if (!verification.rows[0].valid) {
          failures.push({ eventId: id, reason: "record_hash does not match recomputed content — possible tampering or corruption" });
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const sampledCount = sampledIds.length;
    const failureCount = new Set(failures.map((f) => f.eventId)).size;
    const failurePercentage = sampledCount > 0 ? (failureCount / sampledCount) * 100 : 0;
    const status = failureCount > 0 ? "discrepancy_detected" : "healthy";
    const alertTriggered = status === "discrepancy_detected";

    if (alertTriggered) {
      this.logger.error(`ALERT (P1): monthly deep-sample audit found ${failureCount}/${sampledCount} corrupted/incomplete events for tenant ${tenantId}: ${JSON.stringify(failures.slice(0, 20))}`);
    }

    const report = await this.withTenantContext(tenantId, (reportClient) =>
      this.reportRepository.create(
        {
          tenantId,
          reportType: "monthly_deep_sample",
          periodStart,
          periodEnd,
          expectedCount: sampledCount,
          actualCount: sampledCount - failureCount,
          gapCount: failureCount,
          gapPercentage: failurePercentage,
          tolerancePercentage: 0,
          status,
          alertTriggered,
          details: { sampledCount, failures: failures.slice(0, 100) },
        },
        reportClient,
      ),
    );

    if (alertTriggered) {
      await this.recordDeepSampleAudit(tenantId, report, failures);
    }

    return report;
  }

  private async recordDeepSampleAudit(tenantId: string, report: ReconciliationReport, failures: DeepSampleFailure[]): Promise<void> {
    const event: CanonicalAuditEvent = {
      event_id: randomUUID(),
      actor_id: null,
      actor_type: ActorType.SYSTEM,
      tenant_id: tenantId,
      action: "reconciliation.deep_sample_failure",
      resource_type: "audit_reconciliation_report",
      resource_id: report.id,
      data_classification: "confidential",
      ip_address: null,
      change_details: { failure_count: failures.length, sample_size: report.expectedCount },
      correlation_id: report.id,
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
      this.logger.error(`failed to persist reconciliation.deep_sample_failure audit event for report ${report.id}: ${err instanceof Error ? err.message : err}`);
    } finally {
      client.release();
    }
  }

  private async withTenantContext<T>(tenantId: string, fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
