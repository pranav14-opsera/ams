import { test } from "node:test";
import assert from "node:assert/strict";
import { DataClassificationTagger } from "../../src/classification/data-classification-tagger";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";
import { DataClassification } from "../../src/classification/data-classification.enum";

test("tags a normalized event with the platform-computed tier and rule name", () => {
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());
  const tagged = tagger.tag({ tenantId: "tenant-a", resourceType: "health_record", fields: {} });

  assert.equal(tagged.data_classification, DataClassification.RESTRICTED);
  assert.equal(tagged.classification_rule, "restricted-resource-type");
  assert.equal(tagged.tenantId, "tenant-a"); // original event fields propagate downstream, not just the tag
});

test("applies tenant-specific overrides loaded from tenantSettings", () => {
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());
  const tagged = tagger.tag({
    tenantId: "tenant-a",
    resourceType: "team", // platform-INTERNAL by default
    tenantSettings: { classificationOverrides: [{ resourceType: "team", tier: "confidential" }] },
  });

  assert.equal(tagged.data_classification, DataClassification.CONFIDENTIAL);
  assert.equal(tagged.classification_rule, "tenant-override:team");
});

test("the classification tag propagates alongside every other field on the tagged event (downstream consumers see both)", () => {
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());
  const tagged = tagger.tag({ tenantId: "tenant-a", resourceType: "agent", fields: { name: "agent-1" } });

  assert.equal(tagged.resourceType, "agent");
  assert.deepEqual(tagged.fields, { name: "agent-1" });
  assert.ok(tagged.data_classification);
});
