import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassificationTagger } from "../../classification/data-classification-tagger";
import { PhiScrubberService } from "../../phi-scrubber/phi-scrubber.service";
import { TenantRepository } from "../../tenants/tenant.repository";
import { TELEMETRY_PUBLISHER, type TelemetryPublisherPort } from "../kafka/telemetry-publisher.port";
import { TelemetryDeadLetterRepository } from "../kafka/telemetry-dead-letter.repository";
import { TelemetrySchemaValidatorService } from "../telemetry-schema-validator.service";
import type { CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";

export interface TelemetryPipelineResult {
  accepted: true;
  eventId: string;
  dataClassification: string;
  deadLettered: boolean;
}

/**
 * Orchestrates: JSON Schema validation -> tenant context enrichment ->
 * data classification tagging -> PHI scrubbing -> Kafka publication
 * (this WO's own acceptance criteria, in exactly this order).
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

    // Two passes, deliberately: scrub() masks by field NAME (e.g. a
    // `patient_ssn` key, regardless of its value's shape) and by an
    // EXACT whole-value match (a field whose entire value is exactly
    // "123-45-6789"). Neither catches a PHI-shaped value embedded inside
    // a longer free-text string — e.g. a LangChain error message like
    // "rate limit exceeded for patient SSN 123-45-6789" — which is
    // exactly the shape adapter-supplied `metadata.error` content tends
    // to take (found via testing the LangChain adapter's on_llm_error
    // mapping). scrubText() does substring-level masking, so the second
    // pass runs it over the JSON-serialized, already-field-scrubbed
    // metadata to catch those embedded values too.
    const fieldScrubbedMetadata = this.phiScrubber.scrub(event.metadata, tenant?.settings ?? null) as Record<string, unknown>;
    const scrubbedMetadata = JSON.parse(this.phiScrubber.scrubText(JSON.stringify(fieldScrubbedMetadata), tenant?.settings ?? null)) as Record<string, unknown>;
    const outboundEvent: CanonicalTelemetryEvent = { ...event, metadata: scrubbedMetadata };

    let deadLettered = false;
    try {
      await this.publisher.publish(outboundEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown publish error";
      this.logger.warn(`telemetry event ${event.event_id} failed Kafka publication, writing to dead-letter queue: ${message}`);
      await this.deadLetterRepository.record(client, outboundEvent, message);
      deadLettered = true;
    }

    return { accepted: true, eventId: event.event_id, dataClassification: tagged.data_classification, deadLettered };
  }
}
