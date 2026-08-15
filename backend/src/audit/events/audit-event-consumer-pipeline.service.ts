import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AuditStoreRepository } from "../audit-store.repository";
import type { DataClassification } from "../../classification/data-classification.enum";
import { PhiScrubberService } from "../../phi-scrubber/phi-scrubber.service";
import { AuditIngestionCounterRepository } from "../reconciliation/audit-ingestion-counter.repository";
import { AuditEnrichmentService } from "./audit-enrichment.service";
import { AuditEventDeadLetterRepository } from "./audit-event-dead-letter.repository";
import { AuditEventSchemaValidatorService } from "./audit-event-schema-validator.service";
import type { CanonicalAuditEvent } from "./canonical-audit-event";

export interface AuditEventConsumerResult {
  accepted: true;
  eventId: string;
  auditRowId: string | null;
  deadLettered: boolean;
}

/**
 * WO-046's "Kafka consumer service" — in a real deployment this runs as
 * a NestJS microservice reading from the audit-events topic; this
 * sandbox has no reachable Kafka broker or consumer group (confirmed
 * directly, same class of environment gap as WO-034/041/043 — see
 * AUDIT_ENRICHMENT_PIPELINE.md), so this is invoked in-process with one
 * canonical event at a time, exactly the substitution WO-041's
 * MetricsAggregatorService and WO-043's TelemetryPipelineService already
 * established for this codebase. The processing logic itself —
 * validate -> enrich -> PHI scrub -> hash-chain persist, DLQ on any
 * failure — is genuine and fully exercised against real Postgres.
 */
@Injectable()
export class AuditEventConsumerPipelineService {
  private readonly logger = new Logger(AuditEventConsumerPipelineService.name);

  constructor(
    private readonly schemaValidator: AuditEventSchemaValidatorService,
    private readonly enrichmentService: AuditEnrichmentService,
    private readonly phiScrubber: PhiScrubberService,
    private readonly auditStoreRepository: AuditStoreRepository,
    private readonly deadLetterRepository: AuditEventDeadLetterRepository,
    private readonly ingestionCounter: AuditIngestionCounterRepository,
  ) {}

  async process(client: Pool | PoolClient | undefined, event: CanonicalAuditEvent): Promise<AuditEventConsumerResult> {
    // WO-048: counted BEFORE schema validation — an "attempt" for
    // reconciliation purposes means this pipeline was ever invoked with
    // the event at all, regardless of what happens next. Best-effort:
    // a counter failure must never block real event processing.
    if (event?.tenant_id) {
      await this.ingestionCounter.increment(event.tenant_id, new Date(), client).catch((err) => this.logger.warn(`failed to increment ingestion counter for tenant ${event.tenant_id}: ${err instanceof Error ? err.message : err}`));
    }

    const validation = this.schemaValidator.validate(event);
    if (!validation.valid) {
      // Never fail open: an event that doesn't even match the canonical
      // schema still gets a durable record (in the DLQ), rather than
      // being silently discarded — this WO's own AC: "never silently
      // dropped."
      this.logger.warn(`audit event failed schema validation: ${validation.errors.join("; ")}`);
      await this.safeDeadLetter(client, event, `Schema validation failed: ${validation.errors.join("; ")}`);
      return { accepted: true, eventId: (event as Partial<CanonicalAuditEvent>).event_id ?? "unknown", auditRowId: null, deadLettered: true };
    }

    try {
      const enriched = await this.enrichmentService.enrich(event, client);

      // Same two-pass scrub as TelemetryPipelineService (WO-017/035/043):
      // field-name/exact-value pass, then embedded-free-text pass
      // (scrubEmbeddedText, NOT a raw JSON.stringify+scrubText — WO-044
      // found that corrupts non-string JSON values).
      const fieldScrubbed = this.phiScrubber.scrub(enriched.change_details) as Record<string, unknown>;
      const fullyScrubbedDetails = this.phiScrubber.scrubEmbeddedText(fieldScrubbed) as Record<string, unknown>;

      const inserted = await this.auditStoreRepository.insertAuditEvent(
        {
          tenantId: enriched.tenant_id,
          actorId: enriched.actor_type === "user" && enriched.actor_resolved ? enriched.actor_id : null,
          action: enriched.action,
          resourceType: enriched.resource_type,
          resourceId: enriched.resource_id ?? "00000000-0000-0000-0000-000000000000",
          details: { ...fullyScrubbedDetails, actor_type: enriched.actor_type, correlation_id: enriched.correlation_id, ip_address: enriched.ip_address, source_occurred_at: enriched.occurred_at },
          dataClassification: enriched.data_classification as DataClassification,
        },
        client,
      );

      return { accepted: true, eventId: event.event_id, auditRowId: inserted.id, deadLettered: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown enrichment/persistence error";
      this.logger.error(`audit event ${event.event_id} failed enrichment/PHI-scrub/persistence, routing to DLQ: ${message}`);
      await this.safeDeadLetter(client, event, message);
      return { accepted: true, eventId: event.event_id, auditRowId: null, deadLettered: true };
    }
  }

  /** DLQ writes must never themselves take down the pipeline — if even the DLQ write fails (e.g. a genuinely unknown tenant_id that also can't satisfy audit_events_dlq's own FK), log loudly rather than throw, since there is no further fallback below the DLQ. */
  private async safeDeadLetter(client: Pool | PoolClient | undefined, event: CanonicalAuditEvent, errorMessage: string): Promise<void> {
    try {
      await this.deadLetterRepository.record(client, event, errorMessage);
    } catch (dlqErr) {
      this.logger.error(`audit event ${event.event_id} could not even be written to the DLQ — this event is now UNRECOVERABLE: ${dlqErr instanceof Error ? dlqErr.message : dlqErr}`);
    }
  }
}
