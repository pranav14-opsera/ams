import { Injectable } from "@nestjs/common";
import { DataClassification } from "../classification/data-classification.enum";
import type { TaggedEvent } from "../classification/data-classification-tagger";
import { PhiScrubberService } from "./phi-scrubber.service";

export interface ScrubbedEvent extends TaggedEvent {
  phi_scrubbed: boolean;
}

// Sits between DataClassificationTagger (WO-016) and the Kafka producer.
// There is no Kafka client wired into this codebase yet — the acceptance
// criteria's "arrives in Kafka with PHI replaced" is verified in this
// WO's integration test via a mock publish function of the same shape a
// real producer's .send() would have, rather than adding a Kafka client
// dependency to prove a scrubbing behavior that doesn't actually depend
// on Kafka specifically. Wiring a real producer is tracked as follow-up
// work (WO-043, which this WO's own traceability lists as the telemetry
// pipeline's PHI-scrubbing integration point), same connector-gap pattern
// used throughout this codebase (Snyk/SonarQube in WO-008, live EKS in
// WO-012, AWS KMS in WO-015).
@Injectable()
export class PhiScrubberPipelineStage {
  constructor(private readonly phiScrubber: PhiScrubberService) {}

  /**
   * Only RESTRICTED and CONFIDENTIAL events are scrubbed — PUBLIC/
   * INTERNAL events pass through unscrubbed, exactly per this WO's
   * acceptance criteria ("processes every event tagged as RESTRICTED or
   * CONFIDENTIAL"). Scrubbing an already-non-sensitive event would be
   * wasted work and would risk stripping legitimate low-sensitivity data
   * that happens to structurally resemble a PHI pattern (e.g. a
   * PUBLIC-tier system_status payload with a field literally named
   * "date_of_birth_field_test" in some diagnostic tool).
   */
  process(event: TaggedEvent): ScrubbedEvent {
    const needsScrubbing = event.data_classification === DataClassification.RESTRICTED || event.data_classification === DataClassification.CONFIDENTIAL;

    if (!needsScrubbing) {
      return { ...event, phi_scrubbed: false };
    }

    const scrubbedFields = this.phiScrubber.scrub(event.fields, event.tenantSettings) as Record<string, unknown> | undefined;
    return { ...event, fields: scrubbedFields, phi_scrubbed: true };
  }
}
