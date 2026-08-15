import { Module } from "@nestjs/common";
import { AuditEventsModule } from "./events/audit-events.module";
import { AuditExportModule } from "./export/audit-export.module";
import { AuditQueryModule } from "./query/audit-query.module";

// AuditStoreRepository is provided by (and exported through)
// AuditEventsModule, which owns the full write/enrichment/PHI-scrub
// pipeline that uses it — a single shared instance, not a duplicate one
// per module.
@Module({
  imports: [AuditEventsModule, AuditQueryModule, AuditExportModule],
  exports: [AuditEventsModule, AuditQueryModule, AuditExportModule],
})
export class AuditModule {}
