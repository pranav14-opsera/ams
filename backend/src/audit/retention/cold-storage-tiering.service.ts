import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { COLD_STORAGE_ADAPTER, type ColdStorageAdapterPort } from "./cold-storage-adapter.port";
import { ColdStorageManifestRepository } from "./cold-storage-manifest.repository";
import { COLD_STORAGE_TIERING_THRESHOLD_DAYS } from "./retention-policy.constants";

export interface TieringResult {
  partitionName: string;
  rowCount: number;
  storageKey: string;
  status: "tiered" | "already_tiered" | "empty_skipped";
}

interface EligiblePartition {
  partitionName: string;
  periodStart: Date;
  periodEnd: Date;
}

const ROW_BATCH_SIZE = 1000;

// ALTER TABLE ... DETACH PARTITION takes an ACCESS EXCLUSIVE lock on the
// parent table for the (brief) duration of the detach. Found via this WO's
// own full-suite test run: holding (or even just waiting to acquire) that
// lock genuinely deadlocked against UNRELATED concurrent tests' ordinary
// audit_events INSERTs (TenantProvisioningSaga's own audit write), which
// then failed in THEIR OWN test, not this job's — a retry on this side
// alone can't fix that, since this job isn't the one throwing. The actual
// fix: this job never blocks indefinitely waiting for the lock in the
// first place — a short lock_timeout means it backs off and retries
// LATER (giving live traffic priority) instead of queuing behind/against
// concurrent writers and risking exactly this kind of circular wait. A
// real deployment would additionally schedule this job during a
// low-traffic window; this is defense-in-depth for whatever overlap
// remains.
const RETRYABLE_POSTGRES_ERROR_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (our own lock_timeout firing)
]);
const MAX_DETACH_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 200;
const DETACH_LOCK_TIMEOUT_MS = 2000;

function isRetryablePostgresError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && RETRYABLE_POSTGRES_ERROR_CODES.has((err as { code: string }).code);
}

/**
 * WO-049's daily cold storage tiering job. audit_events is RLS-protected
 * per tenant (migration 006), and that protection applies identically
 * whether you query the parent table or one of its monthly partitions
 * directly (PostgreSQL declarative partitioning shares RLS policies with
 * every partition) — so there is no single "read the whole partition"
 * query available to the app's own least-privilege ams_app connection
 * (WO-004's role never bypasses RLS, by design). This job instead loops
 * over every tenant (the `tenants` table itself has no RLS — it IS the
 * tenant dimension), reads that tenant's own rows for the partition's
 * period inside their own set_config'd transaction, and streams all of
 * it into ONE combined archive file. See AUDIT_RETENTION.md.
 */
@Injectable()
export class ColdStorageTieringService {
  private readonly logger = new Logger(ColdStorageTieringService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(COLD_STORAGE_ADAPTER) private readonly coldStorage: ColdStorageAdapterPort,
    private readonly manifestRepository: ColdStorageManifestRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async runDailyTiering(): Promise<TieringResult[]> {
    const cutoff = new Date(Date.now() - COLD_STORAGE_TIERING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const eligible = await this.listEligiblePartitions(cutoff);

    const results: TieringResult[] = [];
    for (const partition of eligible) {
      results.push(await this.tierPartition(partition));
    }
    return results;
  }

  private async listEligiblePartitions(cutoff: Date): Promise<EligiblePartition[]> {
    const result = await this.pool.query("SELECT * FROM list_audit_events_partitions_older_than($1::timestamptz)", [cutoff.toISOString()]);
    return result.rows.map((r: any) => ({ partitionName: r.partition_name, periodStart: r.period_start, periodEnd: r.period_end }));
  }

  private async tierPartition(partition: EligiblePartition): Promise<TieringResult> {
    const existing = await this.manifestRepository.findByPartitionName(partition.partitionName);
    if (existing) {
      return { partitionName: partition.partitionName, rowCount: existing.rowCount, storageKey: existing.storageKey, status: "already_tiered" };
    }

    const tenantIds = await this.listTenantIds();
    const perTenantRowCounts = new Map<string, number>();

    const uploaded = await this.coldStorage.uploadPartitionArchive(partition.partitionName, this.streamAllTenantsRows(tenantIds, partition, perTenantRowCounts));

    if (uploaded.rowCount === 0) {
      // Nothing to archive (e.g. a partition created ahead of time that
      // never received writes) — still safe to drop, but no manifest
      // entry is needed since there is nothing to ever purge from cold
      // storage for it.
      await this.detachAndDropPartitionWithRetry(partition.partitionName);
      return { partitionName: partition.partitionName, rowCount: 0, storageKey: uploaded.storageKey, status: "empty_skipped" };
    }

    const verified = await this.coldStorage.verifyChecksum(uploaded.storageKey, uploaded.checksum);
    if (!verified) {
      throw new Error(`checksum verification failed for tiered partition ${partition.partitionName} — refusing to drop the live partition`);
    }

    await this.manifestRepository.create({
      partitionName: partition.partitionName,
      dataCategory: "audit_logs",
      periodStart: partition.periodStart,
      periodEnd: partition.periodEnd,
      storageKey: uploaded.storageKey,
      checksum: uploaded.checksum,
      rowCount: uploaded.rowCount,
    });

    await this.detachAndDropPartitionWithRetry(partition.partitionName);

    await this.recordTieringAuditEvents(partition, perTenantRowCounts);

    this.logger.log(`tiered partition ${partition.partitionName}: ${uploaded.rowCount} rows across ${perTenantRowCounts.size} tenant(s) -> ${uploaded.storageKey}`);
    return { partitionName: partition.partitionName, rowCount: uploaded.rowCount, storageKey: uploaded.storageKey, status: "tiered" };
  }

  private async detachAndDropPartitionWithRetry(partitionName: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_DETACH_ATTEMPTS; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(`SET lock_timeout = '${DETACH_LOCK_TIMEOUT_MS}ms'`);
        await client.query("SELECT detach_and_drop_audit_events_partition($1)", [partitionName]);
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetryablePostgresError(err) || attempt === MAX_DETACH_ATTEMPTS) throw err;
        this.logger.warn(`detach/drop of partition ${partitionName} attempt ${attempt} could not acquire its lock promptly (giving concurrent live traffic priority), retrying: ${err instanceof Error ? err.message : err}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
      } finally {
        client.release();
      }
    }
    throw lastErr;
  }

  private async listTenantIds(): Promise<string[]> {
    const result = await this.pool.query("SELECT id FROM tenants");
    return result.rows.map((r: { id: string }) => r.id);
  }

  private async *streamAllTenantsRows(tenantIds: string[], partition: EligiblePartition, perTenantRowCounts: Map<string, number>): AsyncGenerator<Record<string, unknown>> {
    for (const tenantId of tenantIds) {
      let rowCount = 0;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

        let cursor: { occurredAt: string; id: string } | null = null;
        for (;;) {
          const params: unknown[] = [tenantId, partition.periodStart.toISOString(), partition.periodEnd.toISOString()];
          let cursorClause = "";
          if (cursor) {
            params.push(cursor.occurredAt, cursor.id);
            cursorClause = ` AND (occurred_at, id) > ($${params.length - 1}, $${params.length})`;
          }
          const page = await client.query(
            `SELECT id, tenant_id, actor_id, action, resource_type, resource_id, data_classification, details, occurred_at, prev_hash, record_hash
             FROM audit_events
             WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3${cursorClause}
             ORDER BY occurred_at ASC, id ASC
             LIMIT ${ROW_BATCH_SIZE}`,
            params,
          );
          for (const row of page.rows) {
            rowCount++;
            yield row;
          }
          if (page.rows.length < ROW_BATCH_SIZE) break;
          const last = page.rows[page.rows.length - 1];
          cursor = { occurredAt: last.occurred_at.toISOString(), id: last.id };
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      if (rowCount > 0) perTenantRowCounts.set(tenantId, rowCount);
    }
  }

  private async recordTieringAuditEvents(partition: EligiblePartition, perTenantRowCounts: Map<string, number>): Promise<void> {
    for (const [tenantId, rowCount] of perTenantRowCounts) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        await this.auditService.recordEvent(
          {
            tenantId,
            actorId: null,
            action: "retention.partition_tiered",
            resourceType: "cold_storage_manifest",
            resourceId: tenantId,
            details: {
              partitionName: partition.partitionName,
              periodStart: partition.periodStart.toISOString(),
              periodEnd: partition.periodEnd.toISOString(),
              rowCount,
              method: "s3_archive_then_drop_partition",
            },
            dataClassification: DataClassification.CONFIDENTIAL,
          },
          client,
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        this.logger.error(`failed to record retention.partition_tiered audit event for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
      } finally {
        client.release();
      }
    }
  }
}
