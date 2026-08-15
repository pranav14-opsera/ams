import { Module } from "@nestjs/common";
import { AuditEventsModule } from "../events/audit-events.module";
import { AuditQueryModule } from "../query/audit-query.module";
import { AuditExportController } from "./audit-export.controller";
import { AuditExportJobRepository } from "./audit-export-job.repository";
import { AuditExportService } from "./audit-export.service";
import { AuditExportWorkerService } from "./audit-export-worker.service";
import { EXPORT_STORAGE_SERVICE } from "./export-storage.port";
import { LocalFilesystemExportStorageService } from "./local-filesystem-export-storage.service";

@Module({
  imports: [AuditQueryModule, AuditEventsModule],
  controllers: [AuditExportController],
  providers: [
    AuditExportJobRepository,
    AuditExportWorkerService,
    AuditExportService,
    // Real S3 has no reachable target in this sandbox (no AWS
    // credentials/endpoint) — same class of gap as WO-015's KmsServicePort
    // only shipping an in-memory adapter. Gated the same way: swap this
    // binding for a real S3-backed implementation when that's actually
    // available, rather than building untested admin-client code now.
    { provide: EXPORT_STORAGE_SERVICE, useClass: LocalFilesystemExportStorageService },
  ],
  exports: [AuditExportService, AuditExportJobRepository],
})
export class AuditExportModule {}
