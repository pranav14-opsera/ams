import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { KMS_SERVICE, type EnvelopeCiphertext, type KeyStatusInfo, type KmsServicePort } from "../tenants/ports/kms-service.port";
import { TenantKeyMetadataRepository } from "../tenants/tenant-key-metadata.repository";

// Wraps KmsServicePort with the durable side effects the acceptance
// criteria call for: recording rotation/deletion-schedule/deletion-cancel
// events (both as tenant_key_metadata current-state updates and as
// audit_events history rows with actor + before/after), and translating
// "no key for this tenant" into a proper 404 rather than a raw port error
// leaking to an HTTP caller.
//
// "A notification event is emitted when deletion is scheduled" — there is
// no email/Slack/messaging connector wired into this codebase yet (same
// connector-gap pattern as Snyk/SonarQube in WO-008 and Kyverno's live
// cluster in WO-012). The audit_events row IS the durable, compliance-
// grade record of that notification; wiring an actual outbound
// notification channel is tracked as follow-up work, not invented here.
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(KMS_SERVICE) private readonly kmsService: KmsServicePort,
    @Inject(TenantKeyMetadataRepository) private readonly tenantKeyMetadataRepository: TenantKeyMetadataRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async encrypt(tenantId: string, plaintext: Buffer): Promise<EnvelopeCiphertext> {
    return this.kmsService.encrypt(tenantId, plaintext);
  }

  async decrypt(tenantId: string, payload: EnvelopeCiphertext): Promise<Buffer> {
    return this.kmsService.decrypt(tenantId, payload);
  }

  async getStatus(tenantId: string): Promise<KeyStatusInfo> {
    return this.requireStatus(tenantId);
  }

  async rotate(tenantId: string, actorId: string | null): Promise<KeyStatusInfo> {
    await this.requireStatus(tenantId); // 404s cleanly if the tenant has no key yet, instead of the port's generic Error
    const { previousVersion, newVersion } = await this.kmsService.rotateKey(tenantId);
    const status = await this.kmsService.getKeyStatus(tenantId);
    await this.tenantKeyMetadataRepository.recordRotation(this.pool, tenantId, newVersion, status.rotationDueAt);
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "tenant.encryption_key.rotated",
      resourceType: "tenant_key_metadata",
      resourceId: tenantId,
      details: { previousVersion, newVersion },
    });
    this.logger.log(`rotated encryption key for tenant ${tenantId}: v${previousVersion} -> v${newVersion}`);
    return status;
  }

  async scheduleDeletion(tenantId: string, actorId: string | null): Promise<KeyStatusInfo> {
    await this.requireStatus(tenantId);
    const { pendingDeletionAt } = await this.kmsService.scheduleKeyDeletion(tenantId);
    await this.tenantKeyMetadataRepository.recordDeletionScheduled(this.pool, tenantId, pendingDeletionAt);
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "tenant.encryption_key.deletion_scheduled",
      resourceType: "tenant_key_metadata",
      resourceId: tenantId,
      details: { pendingDeletionAt: pendingDeletionAt.toISOString() },
    });
    this.logger.warn(`encryption key deletion scheduled for tenant ${tenantId}, effective ${pendingDeletionAt.toISOString()} — accidental deletion here is permanent, unrecoverable data loss`);
    return this.kmsService.getKeyStatus(tenantId);
  }

  async cancelDeletion(tenantId: string, actorId: string | null): Promise<KeyStatusInfo> {
    await this.requireStatus(tenantId);
    await this.kmsService.cancelKeyDeletion(tenantId);
    await this.tenantKeyMetadataRepository.recordDeletionCancelled(this.pool, tenantId);
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "tenant.encryption_key.deletion_cancelled",
      resourceType: "tenant_key_metadata",
      resourceId: tenantId,
      details: {},
    });
    return this.kmsService.getKeyStatus(tenantId);
  }

  private async requireStatus(tenantId: string): Promise<KeyStatusInfo> {
    try {
      return await this.kmsService.getKeyStatus(tenantId);
    } catch {
      throw new NotFoundException(`No encryption key found for tenant ${tenantId}.`);
    }
  }
}
