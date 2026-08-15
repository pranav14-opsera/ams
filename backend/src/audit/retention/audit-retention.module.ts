import { Module } from "@nestjs/common";
import { AuditEventsModule } from "../events/audit-events.module";
import { AUDIT_SERVICE } from "../../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../../tenants/ports/postgres/postgres-audit.service";
import { ColdStorageManifestRepository } from "./cold-storage-manifest.repository";
import { COLD_STORAGE_ADAPTER } from "./cold-storage-adapter.port";
import { ColdStorageTieringService } from "./cold-storage-tiering.service";
import { LocalFilesystemColdStorageService } from "./local-filesystem-cold-storage.service";
import { RetentionPolicyController } from "./retention-policy.controller";
import { RetentionPolicyRepository } from "./retention-policy.repository";
import { RetentionPolicyService } from "./retention-policy.service";
import { RetentionPurgeService } from "./retention-purge.service";

// AUDIT_SERVICE isn't exported from a shared module in this codebase — every
// module that needs it re-provides its own PostgresAuditService binding
// (see tenants.module.ts, rbac.module.ts, agents.module.ts, etc.).
@Module({
  imports: [AuditEventsModule],
  providers: [
    { provide: COLD_STORAGE_ADAPTER, useClass: LocalFilesystemColdStorageService },
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    RetentionPolicyRepository,
    RetentionPolicyService,
    ColdStorageManifestRepository,
    ColdStorageTieringService,
    RetentionPurgeService,
  ],
  exports: [RetentionPolicyRepository, RetentionPolicyService, ColdStorageManifestRepository, ColdStorageTieringService, RetentionPurgeService, COLD_STORAGE_ADAPTER],
  controllers: [RetentionPolicyController],
})
export class AuditRetentionModule {}
