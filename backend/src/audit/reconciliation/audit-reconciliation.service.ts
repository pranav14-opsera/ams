import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { ActorType, type CanonicalAuditEvent } from "../events/canonical-audit-event";
import { AuditEventConsumerPipelineService } from "../events/audit-event-consumer-pipeline.service";
import { AuditEventProducerService } from "../events/audit-event-producer.service";
import { AuditIngestionCounterRepository } from "./audit-ingestion-counter.repository";
import { AuditReconciliationReportRepository } from "./audit-reconciliation-report.repository";
import type { ReconciliationReport } from "./audit-reconciliation-report.repository";

const DEFAULT_TOLERANCE_PERCENTAGE = 0.1; // AC: "default 0.1%"

/**
 * WO-048's daily reconciliation. "Source system counts" are substituted
 * by an ingestion-attempt counter (see migration 041's own header
 * comment and AUDIT_RECONCILIATION.md for the full rationale — no
 * reachable Kafka broker or TimescaleDB in this sandbox). "Actual" is
 * audit_events (persisted) + audit_events_dlq (explicitly failed, still
 * recorded) for the same period — the genuine gap this catches is an
 * event that vanished with NO record at all on either side.
 *
 * There is no dedicated Alert Service anywhere in this codebase (same
 * documented connector gap as WO-008/012/015/039) — a "P1 alert" is a
 * structured Logger.error() line plus the persisted report's own
 * alert_triggered:true flag (immediately queryable via
 * GET /api/v1/audit/reconciliation/reports) plus an audit event of its
 * own (action: reconciliation.gap_detected), the same substitute pattern
 * WO-039's ADAPTER_HEALTH_MONITORING.md already established.
 */
@Injectable()
export class AuditReconciliationService {
  private readonly logger = new Logger(AuditReconciliationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ingestionCounter: AuditIngestionCounterRepository,
    private readonly reportRepository: AuditReconciliationReportRepository,
    private readonly auditProducer: AuditEventProducerService,
    private readonly auditPipeline: AuditEventConsumerPipelineService,
  ) {}

  async runDailyReconciliation(tenantId: string, periodStart: Date, periodEnd: Date, tolerancePercentage = DEFAULT_TOLERANCE_PERCENTAGE): Promise<ReconciliationReport> {
    const client = await this.pool.connect();
    let expectedCount: number;
    let persistedCount: number;
    let dlqCount: number;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

      expectedCount = await this.ingestionCounter.sumForRange(tenantId, periodStart, periodEnd, client);
      const persisted = await client.query("SELECT count(*)::bigint AS c FROM audit_events WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at <= $3", [tenantId, periodStart.toISOString(), periodEnd.toISOString()]);
      persistedCount = Number(persisted.rows[0].c);
      const dlq = await client.query("SELECT count(*)::bigint AS c FROM audit_events_dlq WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3", [tenantId, periodStart.toISOString(), periodEnd.toISOString()]);
      dlqCount = Number(dlq.rows[0].c);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const actualCount = persistedCount + dlqCount;
    const gapCount = Math.max(0, expectedCount - actualCount);
    const gapPercentage = expectedCount > 0 ? (gapCount / expectedCount) * 100 : 0;
    const status = gapPercentage > tolerancePercentage ? "discrepancy_detected" : "healthy";
    const alertTriggered = status === "discrepancy_detected";

    if (alertTriggered) {
      this.logger.error(
        `ALERT (P1): audit reconciliation gap detected for tenant ${tenantId} — expected ${expectedCount}, actual ${actualCount} (persisted ${persistedCount} + DLQ ${dlqCount}), gap ${gapPercentage.toFixed(4)}% exceeds tolerance ${tolerancePercentage}%`,
      );
    }

    const report = await this.withTenantContext(tenantId, (reportClient) =>
      this.reportRepository.create(
        {
          tenantId,
          reportType: "daily_reconciliation",
          periodStart,
          periodEnd,
          expectedCount,
          actualCount,
          gapCount,
          gapPercentage,
          tolerancePercentage,
          status,
          alertTriggered,
          details: { persistedCount, dlqCount },
        },
        reportClient,
      ),
    );

    if (alertTriggered) {
      await this.recordReconciliationAudit(tenantId, report);
    }

    return report;
  }

  private async recordReconciliationAudit(tenantId: string, report: ReconciliationReport): Promise<void> {
    const event: CanonicalAuditEvent = {
      event_id: randomUUID(),
      actor_id: null,
      actor_type: ActorType.SYSTEM,
      tenant_id: tenantId,
      action: "reconciliation.gap_detected",
      resource_type: "audit_reconciliation_report",
      resource_id: report.id,
      data_classification: "confidential",
      ip_address: null,
      change_details: {
        expected_count: report.expectedCount,
        actual_count: report.actualCount,
        gap_count: report.gapCount,
        gap_percentage: report.gapPercentage,
      },
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
      this.logger.error(`failed to persist reconciliation.gap_detected audit event for report ${report.id}: ${err instanceof Error ? err.message : err}`);
    } finally {
      client.release();
    }
  }

  /** audit_reconciliation_reports is RLS-protected like every other tenant-scoped table — needs app.current_tenant set, which the earlier read-only aggregation queries' OWN client (already released by this point) doesn't carry forward. */
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
