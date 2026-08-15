import { Module } from "@nestjs/common";
import { PhiScrubberModule } from "../../phi-scrubber/phi-scrubber.module";
import { TenantsModule } from "../../tenants/tenants.module";
import { AuditStoreRepository } from "../audit-store.repository";
import { AuditEnrichmentService } from "./audit-enrichment.service";
import { AuditEventConsumerPipelineService } from "./audit-event-consumer-pipeline.service";
import { AuditEventDeadLetterRepository } from "./audit-event-dead-letter.repository";
import { AUDIT_EVENT_PUBLISHER } from "./audit-event-publisher.port";
import { AuditEventProducerService } from "./audit-event-producer.service";
import { AuditEventSchemaValidatorService } from "./audit-event-schema-validator.service";
import { KafkaAuditEventProducerService } from "./kafka-audit-event-producer.service";

@Module({
  imports: [TenantsModule, PhiScrubberModule],
  providers: [
    AuditStoreRepository,
    AuditEventSchemaValidatorService,
    AuditEnrichmentService,
    AuditEventDeadLetterRepository,
    KafkaAuditEventProducerService,
    AuditEventProducerService,
    AuditEventConsumerPipelineService,
    // AUDIT_EVENT_PUBLISHER is the token other services should inject if
    // they only need to PUBLISH (not the full producer-with-buffer
    // surface) — bound to the same AuditEventProducerService instance.
    { provide: AUDIT_EVENT_PUBLISHER, useExisting: AuditEventProducerService },
  ],
  // AuditEventProducerService is the shared SDK this WO's AC asks for —
  // every other bounded context that emits audit events imports THIS
  // module and injects it (or AUDIT_EVENT_PUBLISHER).
  exports: [AuditStoreRepository, AuditEventProducerService, AUDIT_EVENT_PUBLISHER, AuditEventConsumerPipelineService, AuditEventDeadLetterRepository],
})
export class AuditEventsModule {}
