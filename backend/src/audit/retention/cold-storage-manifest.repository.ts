import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { DataCategory } from "./retention-policy.constants";

export interface ColdStorageManifestEntry {
  id: string;
  partitionName: string;
  dataCategory: DataCategory;
  periodStart: Date;
  periodEnd: Date;
  storageKey: string;
  checksum: string;
  rowCount: number;
  tieredAt: Date;
  purgedAt: Date | null;
}

function toEntry(row: any): ColdStorageManifestEntry {
  return {
    id: row.id,
    partitionName: row.partition_name,
    dataCategory: row.data_category,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    storageKey: row.storage_key,
    checksum: row.checksum,
    rowCount: Number(row.row_count),
    tieredAt: row.tiered_at,
    purgedAt: row.purged_at,
  };
}

// Deliberately NOT tenant-scoped (no RLS) — see migration 043's own header
// comment: a single audit_events partition holds every tenant's rows for
// that period, so "which partitions have been tiered/purged" is a
// platform-level fact, not a per-tenant one.
@Injectable()
export class ColdStorageManifestRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByPartitionName(partitionName: string, client?: Pool | PoolClient): Promise<ColdStorageManifestEntry | null> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT * FROM cold_storage_manifest WHERE partition_name = $1", [partitionName]);
    return result.rows.length > 0 ? toEntry(result.rows[0]) : null;
  }

  async create(input: { partitionName: string; dataCategory: DataCategory; periodStart: Date; periodEnd: Date; storageKey: string; checksum: string; rowCount: number }, client?: Pool | PoolClient): Promise<ColdStorageManifestEntry> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      `INSERT INTO cold_storage_manifest (partition_name, data_category, period_start, period_end, storage_key, checksum, row_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.partitionName, input.dataCategory, input.periodStart.toISOString(), input.periodEnd.toISOString(), input.storageKey, input.checksum, input.rowCount],
    );
    return toEntry(result.rows[0]);
  }

  async findUnpurged(client?: Pool | PoolClient): Promise<ColdStorageManifestEntry[]> {
    const executor = client ?? this.pool;
    const result = await executor.query("SELECT * FROM cold_storage_manifest WHERE purged_at IS NULL ORDER BY period_end ASC");
    return result.rows.map(toEntry);
  }

  /** All not-yet-purged manifest entries whose period overlaps [startTime, endTime] — the query-federation seam's lookup. */
  async findOverlappingUnpurged(startTime: Date, endTime: Date, client?: Pool | PoolClient): Promise<ColdStorageManifestEntry[]> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      "SELECT * FROM cold_storage_manifest WHERE purged_at IS NULL AND period_start <= $2 AND period_end >= $1 ORDER BY period_start ASC",
      [startTime.toISOString(), endTime.toISOString()],
    );
    return result.rows.map(toEntry);
  }

  async markPurged(id: string, client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query("UPDATE cold_storage_manifest SET purged_at = now() WHERE id = $1", [id]);
  }
}
