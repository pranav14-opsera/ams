import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

export type ReconciliationReportType = "daily_reconciliation" | "monthly_deep_sample";
export type ReconciliationStatus = "healthy" | "discrepancy_detected";

export interface ReconciliationReport {
  id: string;
  tenantId: string;
  reportType: ReconciliationReportType;
  periodStart: Date;
  periodEnd: Date;
  expectedCount: number;
  actualCount: number;
  gapCount: number;
  gapPercentage: number;
  tolerancePercentage: number;
  status: ReconciliationStatus;
  alertTriggered: boolean;
  details: Record<string, unknown>;
  createdAt: Date;
}

function toReport(row: any): ReconciliationReport {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    reportType: row.report_type,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    expectedCount: Number(row.expected_count),
    actualCount: Number(row.actual_count),
    gapCount: Number(row.gap_count),
    gapPercentage: Number(row.gap_percentage),
    tolerancePercentage: Number(row.tolerance_percentage),
    status: row.status,
    alertTriggered: row.alert_triggered,
    details: row.details,
    createdAt: row.created_at,
  };
}

export interface CreateReconciliationReportInput {
  tenantId: string;
  reportType: ReconciliationReportType;
  periodStart: Date;
  periodEnd: Date;
  expectedCount: number;
  actualCount: number;
  gapCount: number;
  gapPercentage: number;
  tolerancePercentage: number;
  status: ReconciliationStatus;
  alertTriggered: boolean;
  details: Record<string, unknown>;
}

@Injectable()
export class AuditReconciliationReportRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(input: CreateReconciliationReportInput, client?: Pool | PoolClient): Promise<ReconciliationReport> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      `INSERT INTO audit_reconciliation_reports
         (tenant_id, report_type, period_start, period_end, expected_count, actual_count, gap_count, gap_percentage, tolerance_percentage, status, alert_triggered, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.tenantId,
        input.reportType,
        input.periodStart.toISOString(),
        input.periodEnd.toISOString(),
        input.expectedCount,
        input.actualCount,
        input.gapCount,
        input.gapPercentage,
        input.tolerancePercentage,
        input.status,
        input.alertTriggered,
        JSON.stringify(input.details),
      ],
    );
    return toReport(result.rows[0]);
  }

  async findByTenant(tenantId: string, filters: { reportType?: ReconciliationReportType; since?: Date; until?: Date } = {}, client?: Pool | PoolClient): Promise<ReconciliationReport[]> {
    const executor = client ?? this.pool;
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filters.reportType) {
      params.push(filters.reportType);
      conditions.push(`report_type = $${params.length}`);
    }
    if (filters.since) {
      params.push(filters.since.toISOString());
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filters.until) {
      params.push(filters.until.toISOString());
      conditions.push(`created_at <= $${params.length}`);
    }

    const result = await executor.query(`SELECT * FROM audit_reconciliation_reports WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`, params);
    return result.rows.map(toReport);
  }
}
