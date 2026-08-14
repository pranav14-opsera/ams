// Entry point for the scheduled job that executes key deletions whose
// 7-day mandatory wait has elapsed. Not wired to any scheduler here —
// same pattern as database/migrations/007's
// create_agent_metrics_partitions ("intended to run hourly thereafter via
// a scheduled Lambda/cron, not implemented here") and 005's monthly audit
// partition creation. Run manually via `npx tsx src/encryption/process-key-deletions.script.ts`
// or wire to an external scheduler (Lambda/cron) in deployed environments.
//
// Deliberately does NOT touch the KMS adapter's in-memory state directly —
// this process runs in its own Node process/invocation, so it goes
// through the same EncryptionModule wiring the API server uses, reading
// tenant_key_metadata (the durable record) to decide what's expired, then
// calling the real port to execute the deletion.
import { Pool } from "pg";
import { InMemoryKmsService } from "../tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { TenantKeyMetadataRepository } from "../tenants/tenant-key-metadata.repository";
import { TenantRepository } from "../tenants/tenant.repository";

export async function processExpiredKeyDeletions(pool: Pool, kmsService: { deleteTenantKey(keyArn: string): Promise<void> }): Promise<string[]> {
  const keyMetadataRepository = new TenantKeyMetadataRepository();
  const tenantRepository = new TenantRepository();
  const auditService = new PostgresAuditService(pool);

  const expired = await keyMetadataRepository.findExpiredDeletions(pool, new Date());
  const processedTenantIds: string[] = [];

  for (const record of expired) {
    await kmsService.deleteTenantKey(record.keyArn);
    await keyMetadataRepository.markDisabled(pool, record.tenantId);

    const tenant = await tenantRepository.findById(pool, record.tenantId);
    await auditService.recordEvent({
      tenantId: record.tenantId,
      actorId: null,
      action: "tenant.encryption_key.deletion_executed",
      resourceType: "tenant_key_metadata",
      resourceId: record.tenantId,
      details: { keyArn: record.keyArn, tenantSlug: tenant?.slug ?? null },
    });
    processedTenantIds.push(record.tenantId);
  }

  return processedTenantIds;
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const kmsService = process.env.KMS_ADAPTER === "mock" || !process.env.KMS_ADAPTER ? new InMemoryKmsService() : (() => {
    throw new Error(`KMS_ADAPTER=${process.env.KMS_ADAPTER} is not implemented — see encryption.module.ts.`);
  })();
  processExpiredKeyDeletions(pool, kmsService)
    .then((processed) => {
      // eslint-disable-next-line no-console
      console.log(`Processed ${processed.length} expired key deletion(s): ${processed.join(", ") || "(none)"}`);
      return pool.end();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Failed to process expired key deletions:", err);
      process.exitCode = 1;
    });
}
