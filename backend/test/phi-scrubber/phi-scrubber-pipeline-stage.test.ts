import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { PhiScrubberPipelineStage } from "../../src/phi-scrubber/phi-scrubber-pipeline-stage";
import { DataClassification } from "../../src/classification/data-classification.enum";
import { DataClassificationTagger } from "../../src/classification/data-classification-tagger";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";

test("scrubs RESTRICTED-tagged events before they'd be published", () => {
  const stage = new PhiScrubberPipelineStage(new PhiScrubberService());
  const tagged = new DataClassificationTagger(new ClassificationRuleEngine()).tag({
    tenantId: "tenant-a",
    resourceType: "health_record",
    fields: { patient_id: "12345", note: "routine checkup" },
  });

  const scrubbed = stage.process(tagged);

  assert.equal(scrubbed.phi_scrubbed, true);
  assert.deepEqual(scrubbed.fields, { patient_id: "[MASKED]", note: "routine checkup" });
});

test("scrubs CONFIDENTIAL-tagged events too", () => {
  const stage = new PhiScrubberPipelineStage(new PhiScrubberService());
  const tagged = new DataClassificationTagger(new ClassificationRuleEngine()).tag({
    tenantId: "tenant-a",
    resourceType: "credit_transaction",
    fields: { amount: 42.5, ssn: "123-45-6789" },
  });

  const scrubbed = stage.process(tagged);
  assert.equal(scrubbed.phi_scrubbed, true);
  assert.deepEqual(scrubbed.fields, { amount: 42.5, ssn: "[MASKED]" });
});

test("does NOT scrub PUBLIC/INTERNAL-tagged events (acceptance criteria: only RESTRICTED/CONFIDENTIAL)", () => {
  const stage = new PhiScrubberPipelineStage(new PhiScrubberService());
  const tagged = new DataClassificationTagger(new ClassificationRuleEngine()).tag({
    tenantId: "tenant-a",
    resourceType: "agent",
    fields: { name: "billing-agent" },
  });

  assert.equal(tagged.data_classification, DataClassification.INTERNAL);
  const scrubbed = stage.process(tagged);
  assert.equal(scrubbed.phi_scrubbed, false);
  assert.deepEqual(scrubbed.fields, { name: "billing-agent" });
});
