import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

export interface TenantKeyMetadata {
  tenantId: string;
  keyArn: string;
  status: "active" | "pending_deletion" | "disabled";
  currentVersion: number;
  rotationDueAt: Date;
  pendingDeletionAt: Date | null;
}

interface TenantKeyMetadataRow {
  tenant_id: string;
  key_arn: string;
  status: TenantKeyMetadata["status"];
  current_version: number;
  rotation_due_at: Date;
  pending_deletion_at: Date | null;
}

function toMetadata(row: TenantKeyMetadataRow): TenantKeyMetadata {
  return {
    tenantId: row.tenant_id,
    keyArn: row.key_arn,
    status: row.status,
    currentVersion: row.current_version,
    rotationDueAt: row.rotation_due_at,
    pendingDeletionAt: row.pending_deletion_at,
  };
}

// Durable record of key lifecycle state — see migration
// 016_tenant_key_metadata.sql's header for why this exists alongside the
// KMS adapter's own live state.
@Injectable()
export class TenantKeyMetadataRepository {
  async create(client: PoolClient, input: { tenantId: string; keyArn: string; rotationDueAt: Date }): Promise<void> {
    await client.query(
      `INSERT INTO tenant_key_metadata (tenant_id, key_arn, current_version, rotation_due_at)
       VALUES ($1, $2, 1, $3)`,
      [input.tenantId, input.keyArn, input.rotationDueAt],
    );
  }

  async findByTenantId(clientOrPool: PoolClient | Pool, tenantId: string): Promise<TenantKeyMetadata | null> {
    const result = await clientOrPool.query<TenantKeyMetadataRow>("SELECT * FROM tenant_key_metadata WHERE tenant_id = $1", [tenantId]);
    return result.rows[0] ? toMetadata(result.rows[0]) : null;
  }

  async recordRotation(clientOrPool: PoolClient | Pool, tenantId: string, newVersion: number, rotationDueAt: Date): Promise<void> {
    await clientOrPool.query(
      `UPDATE tenant_key_metadata SET current_version = $1, rotation_due_at = $2, updated_at = now() WHERE tenant_id = $3`,
      [newVersion, rotationDueAt, tenantId],
    );
  }

  async recordDeletionScheduled(clientOrPool: PoolClient | Pool, tenantId: string, pendingDeletionAt: Date): Promise<void> {
    await clientOrPool.query(
      `UPDATE tenant_key_metadata SET status = 'pending_deletion', pending_deletion_at = $1, updated_at = now() WHERE tenant_id = $2`,
      [pendingDeletionAt, tenantId],
    );
  }

  async recordDeletionCancelled(clientOrPool: PoolClient | Pool, tenantId: string): Promise<void> {
    await clientOrPool.query(
      `UPDATE tenant_key_metadata SET status = 'active', pending_deletion_at = NULL, updated_at = now() WHERE tenant_id = $1`,
      [tenantId],
    );
  }

  /** Tenants whose scheduled deletion has elapsed — the query the scheduled deletion job (scripts/process-key-deletions.ts) runs. */
  async findExpiredDeletions(clientOrPool: PoolClient | Pool, now: Date): Promise<TenantKeyMetadata[]> {
    const result = await clientOrPool.query<TenantKeyMetadataRow>(
      `SELECT * FROM tenant_key_metadata WHERE status = 'pending_deletion' AND pending_deletion_at <= $1`,
      [now],
    );
    return result.rows.map(toMetadata);
  }

  async markDisabled(clientOrPool: PoolClient | Pool, tenantId: string): Promise<void> {
    await clientOrPool.query(`UPDATE tenant_key_metadata SET status = 'disabled', updated_at = now() WHERE tenant_id = $1`, [tenantId]);
  }
}
