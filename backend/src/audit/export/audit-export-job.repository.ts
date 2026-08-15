import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

export type AuditExportJobStatus = "pending" | "processing" | "completed" | "failed";

export interface AuditExportJob {
  id: string;
  tenantId: string;
  requestedBy: string | null;
  status: AuditExportJobStatus;
  filters: Record<string, unknown>;
  recordCount: number | null;
  storageKey: string | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

function toJob(row: any): AuditExportJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestedBy: row.requested_by,
    status: row.status,
    filters: row.filters,
    recordCount: row.record_count,
    storageKey: row.storage_key,
    downloadUrl: row.download_url,
    downloadUrlExpiresAt: row.download_url_expires_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

@Injectable()
export class AuditExportJobRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(tenantId: string, requestedBy: string | null, filters: Record<string, unknown>, client?: Pool | PoolClient): Promise<AuditExportJob> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      `INSERT INTO audit_export_jobs (tenant_id, requested_by, filters) VALUES ($1, $2, $3) RETURNING *`,
      [tenantId, requestedBy, JSON.stringify(filters)],
    );
    return toJob(result.rows[0]);
  }

  async findById(tenantId: string, id: string, client?: Pool | PoolClient): Promise<AuditExportJob | null> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT * FROM audit_export_jobs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async countActive(tenantId: string, client?: Pool | PoolClient): Promise<number> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT count(*)::int AS c FROM audit_export_jobs WHERE tenant_id = $1 AND status IN ('pending', 'processing')", [tenantId]);
    return result.rows[0].c;
  }

  async markProcessing(id: string, client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query("UPDATE audit_export_jobs SET status = 'processing' WHERE id = $1", [id]);
  }

  async markCompleted(id: string, recordCount: number, storageKey: string, downloadUrl: string, downloadUrlExpiresAt: Date, client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `UPDATE audit_export_jobs
       SET status = 'completed', record_count = $2, storage_key = $3, download_url = $4, download_url_expires_at = $5, completed_at = now()
       WHERE id = $1`,
      [id, recordCount, storageKey, downloadUrl, downloadUrlExpiresAt],
    );
  }

  async markFailed(id: string, errorMessage: string, client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query("UPDATE audit_export_jobs SET status = 'failed', error_message = $2, completed_at = now() WHERE id = $1", [id, errorMessage]);
  }
}
