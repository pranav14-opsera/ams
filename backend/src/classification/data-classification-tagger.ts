import { Injectable } from "@nestjs/common";
import { ClassificationRuleEngine, type ClassifiablePayload } from "./classification-rule-engine";
import { loadTenantClassificationOverrides } from "./tenant-classification-overrides";
import type { DataClassification } from "./data-classification.enum";

export interface NormalizedEvent extends ClassifiablePayload {
  tenantId: string;
  tenantSettings?: Record<string, unknown> | null;
}

export interface TaggedEvent extends NormalizedEvent {
  data_classification: DataClassification;
  classification_rule: string;
}

// Pipeline stage: Tenant Context Enricher -> DataClassificationTagger ->
// PHI Scrubber (WO-017). Sits here specifically so the PHI Scrubber can
// use the tag this stage attaches (e.g. to decide how aggressively to
// scrub, or to skip already-Restricted payloads it would scrub anyway) —
// this WO's own description calls this "a hard pipeline ordering
// dependency", so a caller wiring the pipeline in the wrong order changes
// what the scrubber sees, not just when.
@Injectable()
export class DataClassificationTagger {
  constructor(private readonly ruleEngine: ClassificationRuleEngine) {}

  tag(event: NormalizedEvent): TaggedEvent {
    const overrides = loadTenantClassificationOverrides(event.tenantSettings);
    const { tier, matchedRule } = this.ruleEngine.evaluate(event, overrides);
    return {
      ...event,
      data_classification: tier,
      classification_rule: matchedRule,
    };
  }
}
