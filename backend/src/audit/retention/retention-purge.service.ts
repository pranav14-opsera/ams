import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { COLD_STORAGE_ADAPTER, type ColdStorageAdapterPort } from "./cold-storage-adapter.port";
import type { ColdStorageManifestEntry } from "./cold-storage-manifest.repository";
import { ColdStorageManifestRepository } from "./cold-storage-manifest.repository";
import { RETENTION_BOUNDS } from "./retention-policy.constants";
import { RetentionPolicyRepository } from "./retention-policy.repository";
import { RetentionPolicyService } from "./retention-policy.service";

export interface PurgeResult {
  partitionName: string;
  rowsPurged: number;
  status: "purged" | "not_yet_eligible";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * WO-049's daily purge job. A tiered archive covers every tenant's rows
 * for that period (see ColdStorageTieringService's own header comment) —
 * it can only be deleted once EVERY tenant's own retention_days for
 * audit_logs has elapsed for that period, never merely the requesting
 * tenant's own policy. This conservatively uses the MAXIMUM
 * effective-retention across all tenants (falling back to the audit_logs
 * category default for tenants with no override) as the purge-eligibility
 * threshold — a tenant's data is never purged earlier than their own
 * configured policy allows, at the cost of sometimes retaining another
 * tenant's already-expired data a little longer within the same shared
 * archive. See AUDIT_RETENTION.md.
 */
@Injectable()
export class RetentionPurgeService {
  private readonly logger = new Logger(RetentionPurgeService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(COLD_STORAGE_ADAPTER) private readonly coldStorage: ColdStorageAdapterPort,
    private readonly manifestRepository: ColdStorageManifestRepository,
    private readonly retentionPolicyRepository: RetentionPolicyRepository,
    private readonly retentionPolicyService: RetentionPolicyService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async runDailyPurge(): Promise<PurgeResult[]> {
    const unpurged = await this.manifestRepository.findUnpurged();
    const maxRetentionDays = await this.maxEffectiveRetentionDaysAcrossTenants();

    const results: PurgeResult[] = [];
    for (const entry of unpurged) {
      results.push(await this.purgeIfEligible(entry, maxRetentionDays));
    }
    return results;
  }

  private async purgeIfEligible(entry: ColdStorageManifestEntry, maxRetentionDays: number): Promise<PurgeResult> {
    const eligibleAt = entry.periodEnd.getTime() + maxRetentionDays * DAY_MS;
    if (Date.now() < eligibleAt) {
      return { partitionName: entry.partitionName, rowsPurged: 0, status: "not_yet_eligible" };
    }

    const perTenantRowCounts = await this.countRowsByTenant(entry);
    await this.recordPurgeAuditEvents(entry, perTenantRowCounts);
    await this.coldStorage.deleteArchive(entry.storageKey);
    await this.manifestRepository.markPurged(entry.id);

    this.logger.log(`purged cold-storage archive for partition ${entry.partitionName} (${entry.rowCount} rows, retention ${maxRetentionDays}d elapsed since period end)`);
    return { partitionName: entry.partitionName, rowsPurged: entry.rowCount, status: "purged" };
  }

  private async countRowsByTenant(entry: ColdStorageManifestEntry): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for await (const row of this.coldStorage.readArchive(entry.storageKey)) {
      const tenantId = row.tenant_id as string;
      counts.set(tenantId, (counts.get(tenantId) ?? 0) + 1);
    }
    return counts;
  }

  private async recordPurgeAuditEvents(entry: ColdStorageManifestEntry, perTenantRowCounts: Map<string, number>): Promise<void> {
    for (const [tenantId, rowCount] of perTenantRowCounts) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        await this.auditService.recordEvent(
          {
            tenantId,
            actorId: null,
            action: "retention.data_purged",
            resourceType: "cold_storage_manifest",
            resourceId: tenantId,
            details: {
              partitionName: entry.partitionName,
              periodStart: entry.periodStart.toISOString(),
              periodEnd: entry.periodEnd.toISOString(),
              rowCount,
              method: "cryptographic_erasure_cold_archive_delete",
            },
            dataClassification: DataClassification.CONFIDENTIAL,
          },
          client,
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        this.logger.error(`failed to record retention.data_purged audit event for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
      } finally {
        client.release();
      }
    }
  }

  private async maxEffectiveRetentionDaysAcrossTenants(): Promise<number> {
    const tenantIds = (await this.pool.query("SELECT id FROM tenants")).rows.map((r: { id: string }) => r.id);
    let max = RETENTION_BOUNDS.audit_logs.defaultDays;

    for (const tenantId of tenantIds) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        const policy = await this.retentionPolicyRepository.findOne(tenantId, "audit_logs", client);
        await client.query("COMMIT");
        if (policy) max = Math.max(max, this.retentionPolicyService.effectiveRetentionDays(policy));
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
    return max;
  }
}
