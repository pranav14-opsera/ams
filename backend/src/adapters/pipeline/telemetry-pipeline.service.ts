import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassificationTagger } from "../../classification/data-classification-tagger";
import { PhiAuditEmitter } from "../../phi-scrubber/phi-audit-emitter";
import { PhiQuarantineRepository } from "../../phi-scrubber/phi-quarantine.repository";
import { PhiScrubberService, type PhiDetection } from "../../phi-scrubber/phi-scrubber.service";
import { PhiSecondaryValidator } from "../../phi-scrubber/phi-secondary-validator";
import { TenantRepository } from "../../tenants/tenant.repository";
import { TELEMETRY_PUBLISHER, type TelemetryPublisherPort } from "../kafka/telemetry-publisher.port";
import { TelemetryDeadLetterRepository } from "../kafka/telemetry-dead-letter.repository";
import { MetricsAggregatorService } from "../metrics/metrics-aggregator.service";
import { TelemetrySchemaValidatorService } from "../telemetry-schema-validator.service";
import type { CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";

export interface TelemetryPipelineResult {
  accepted: true;
  eventId: string;
  dataClassification: string;
  deadLettered: boolean;
  /** WO-043: true if PhiSecondaryValidator found residual PHI (or primary scrubbing itself threw) and the event was routed to phi_quarantine_events instead of Kafka. */
  quarantined: boolean;
}

/**
 * Orchestrates: JSON Schema validation -> tenant context enrichment ->
 * data classification tagging -> PHI scrubbing -> secondary PHI validation
 * (WO-043 defense-in-depth quarantine gate) -> Kafka publication (this
 * WO's own acceptance criteria, in exactly this order).
 *
 * PHI scrubbing is applied directly to `metadata` — the canonical
 * schema's ONE free-form field (every other field is strictly typed:
 * a number, a boolean, an enum, a UUID) — via WO-017's PhiScrubberService,
 * rather than routing through PhiScrubberPipelineStage's classification-
 * gated logic (WO-016/017's original pipeline: gate scrubbing on
 * RESTRICTED/CONFIDENTIAL tier). A telemetry event's resourceType always
 * classifies as INTERNAL (agent_metrics is in that tier's default rule
 * set) and its schema's `additionalProperties: false` means no field name
 * can ever match the RESTRICTED field-name pattern either — gating on
 * tier here would mean telemetry metadata is NEVER scrubbed, which
 * contradicts this WO's own unconditional "PHI scrubbing replaces
 * detected PHI patterns... before Kafka publication." Reuses
 * WO-016's DataClassificationTagger for the tier itself (attached to
 * telemetry_dead_letter_events/logs for triage — it deliberately isn't
 * injected into the canonical wire payload, whose schema has no slot
 * for it) and WO-017's PhiScrubberService for the actual masking, rather
 * than re-implementing either.
 *
 * WO-043 adds two things on top of WO-017's two-pass scrub: (1) every
 * masked field produces an immutable audit_events record via
 * PhiAuditEmitter, and (2) PhiSecondaryValidator re-scans the ALREADY-
 * scrubbed output — if it still finds PHI-shaped content (or primary
 * scrubbing itself throws for any reason), the event is quarantined to
 * phi_quarantine_events instead of ever reaching Kafka. "Never fail
 * open" is structural here: quarantining is what the catch block does,
 * not an afterthought bolted onto the happy path.
 */
@Injectable()
export class TelemetryPipelineService {
  private readonly logger = new Logger(TelemetryPipelineService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly schemaValidator: TelemetrySchemaValidatorService,
    private readonly tenantRepository: TenantRepository,
    private readonly classificationTagger: DataClassificationTagger,
    private readonly phiScrubber: PhiScrubberService,
    @Inject(TELEMETRY_PUBLISHER) private readonly publisher: TelemetryPublisherPort,
    private readonly deadLetterRepository: TelemetryDeadLetterRepository,
    private readonly metricsAggregator: MetricsAggregatorService,
    private readonly phiSecondaryValidator: PhiSecondaryValidator,
    private readonly phiAuditEmitter: PhiAuditEmitter,
    private readonly phiQuarantineRepository: PhiQuarantineRepository,
  ) {}

  async process(client: Pool | PoolClient | undefined, event: CanonicalTelemetryEvent): Promise<TelemetryPipelineResult> {
    const validation = this.schemaValidator.validate(event);
    if (!validation.valid) {
      // AC: "logged with the validation errors but without the raw
      // payload content" — errors reference field paths only, never the
      // event's own field values.
      this.logger.warn(`telemetry event failed schema validation: ${validation.errors.join("; ")}`);
      throw new BadRequestException({ error: "validation_error", message: "Telemetry event failed schema validation.", details: validation.errors });
    }

    const executor = client ?? this.pool;
    const tenant = await this.tenantRepository.findById(executor, event.tenant_id);
    const tagged = this.classificationTagger.tag({
      resourceType: "agent_metrics",
      tenantId: event.tenant_id,
      tenantSettings: tenant?.settings ?? null,
      fields: event as unknown as Record<string, unknown>,
    });

    // WO-043: never fail open. Any exception during scrubbing/validation
    // itself (not a Kafka publish failure — that's handled separately
    // below) means we cannot prove the event is PHI-safe, so it is
    // quarantined rather than published in whatever state it was in when
    // the exception occurred.
    let scrubbedMetadata: Record<string, unknown>;
    let detections: PhiDetection[];
    try {
      const result = this.scrubMetadata(event.metadata, tenant?.settings ?? null);
      scrubbedMetadata = result.scrubbedMetadata;
      detections = result.detections;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown PHI scrubbing error";
      this.logger.error(`telemetry event ${event.event_id} failed PHI scrubbing, quarantining rather than publishing unscrubbed: ${message}`);
      await this.phiQuarantineRepository.record(client, event, `PHI scrubbing error: ${message}`);
      return { accepted: true, eventId: event.event_id, dataClassification: tagged.data_classification, deadLettered: false, quarantined: true };
    }

    if (detections.length > 0) {
      await this.phiAuditEmitter.recordDetections(client as PoolClient | undefined, event.tenant_id, event.agent_id, event.event_id, tagged.data_classification, detections);
    }

    const outboundEvent: CanonicalTelemetryEvent = { ...event, metadata: scrubbedMetadata };

    // Defense-in-depth quarantine gate: re-scan the ALREADY-scrubbed
    // output. If PHI-shaped content survived the primary pass, this event
    // must never reach Kafka.
    if (this.phiSecondaryValidator.hasResidualPhi(scrubbedMetadata, tenant?.settings ?? null)) {
      this.logger.error(`telemetry event ${event.event_id} failed secondary PHI validation after primary scrubbing — quarantining instead of publishing`);
      await this.phiQuarantineRepository.record(client, outboundEvent, "Secondary PHI validation detected residual PHI-shaped content after primary scrubbing.");
      await this.metricsAggregator.recordCanonicalEvent(client, outboundEvent);
      return { accepted: true, eventId: event.event_id, dataClassification: tagged.data_classification, deadLettered: false, quarantined: true };
    }

    let deadLettered = false;
    try {
      await this.publisher.publish(outboundEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown publish error";
      this.logger.warn(`telemetry event ${event.event_id} failed Kafka publication, writing to dead-letter queue: ${message}`);
      await this.deadLetterRepository.record(client, outboundEvent, message);
      deadLettered = true;
    }

    // WO-041: feeds the pre-existing agent_metrics rolling-aggregate
    // pipeline (migration 007) — recorded regardless of Kafka publish
    // outcome, since this is about the agent's own observed behavior,
    // not about delivery status.
    await this.metricsAggregator.recordCanonicalEvent(client, outboundEvent);

    return { accepted: true, eventId: event.event_id, dataClassification: tagged.data_classification, deadLettered, quarantined: false };
  }

  /**
   * WO-017's two-pass scrub (field/exact-value, then embedded-substring),
   * combined into one call that also returns what was masked (for
   * WO-043's audit trail). Split out of process() so the "never fail
   * open" try/catch above has a single call site to guard.
   */
  private scrubMetadata(metadata: Record<string, unknown>, tenantSettings: Record<string, unknown> | null): { scrubbedMetadata: Record<string, unknown>; detections: PhiDetection[] } {
    const { result: fieldScrubbedMetadata, detections: fieldDetections } = this.phiScrubber.scrubWithDetections(metadata, tenantSettings);

    // scrubText() does substring-level masking over the JSON-serialized,
    // already-field-scrubbed metadata to catch PHI embedded inside a
    // longer free-text string (e.g. a LangChain error message like "rate
    // limit exceeded for patient SSN 123-45-6789") that scrub()'s
    // field-name/exact-whole-value matching alone would miss (WO-035).
    const serializedFieldScrubbed = JSON.stringify(fieldScrubbedMetadata);
    const serializedFullyScrubbed = this.phiScrubber.scrubText(serializedFieldScrubbed, tenantSettings);
    const textPassDetections: PhiDetection[] =
      serializedFullyScrubbed !== serializedFieldScrubbed ? [{ fieldPath: "metadata (embedded free text)", reason: "value_shape" }] : [];

    return { scrubbedMetadata: JSON.parse(serializedFullyScrubbed) as Record<string, unknown>, detections: [...fieldDetections, ...textPassDetections] };
  }
}
