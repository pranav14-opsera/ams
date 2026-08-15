import { Module } from "@nestjs/common";
import { AuditEventsModule } from "./events/audit-events.module";

// AuditStoreRepository is provided by (and exported through)
// AuditEventsModule, which owns the full write/enrichment/PHI-scrub
// pipeline that uses it — a single shared instance, not a duplicate one
// per module.
@Module({
  imports: [AuditEventsModule],
  exports: [AuditEventsModule],
})
export class AuditModule {}
