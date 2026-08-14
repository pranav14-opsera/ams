import { test } from "node:test";
import assert from "node:assert/strict";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";
import { DataClassification } from "../../src/classification/data-classification.enum";
import fixtures from "../fixtures/classification/sample-payloads.json";

test("classifies each platform-default tier correctly", () => {
  const engine = new ClassificationRuleEngine();

  for (const payload of fixtures.public) {
    assert.equal(engine.evaluate(payload).tier, DataClassification.PUBLIC, JSON.stringify(payload));
  }
  for (const payload of fixtures.internal) {
    assert.equal(engine.evaluate(payload).tier, DataClassification.INTERNAL, JSON.stringify(payload));
  }
  for (const payload of fixtures.confidential) {
    assert.equal(engine.evaluate(payload).tier, DataClassification.CONFIDENTIAL, JSON.stringify(payload));
  }
  for (const payload of fixtures.restricted) {
    assert.equal(engine.evaluate(payload).tier, DataClassification.RESTRICTED, JSON.stringify(payload));
  }
});

test("unrecognized data defaults to CONFIDENTIAL, never PUBLIC (fail-safe)", () => {
  const engine = new ClassificationRuleEngine();
  for (const payload of fixtures.unknown_defaults_to_confidential) {
    const result = engine.evaluate(payload as any);
    assert.equal(result.tier, DataClassification.CONFIDENTIAL);
    assert.equal(result.matchedRule, "default-fallback");
  }
});

test("mixed-tier edge cases: rule ordering (Restricted first) beats a lower structural or declared signal", () => {
  const engine = new ClassificationRuleEngine();
  for (const { payload, expectedTier } of fixtures.mixed_tier_edge_cases) {
    const result = engine.evaluate(payload as any);
    assert.equal(result.tier, expectedTier, JSON.stringify(payload));
  }
});

test("empty payload (no resourceType match, no fields) defaults to CONFIDENTIAL", () => {
  const engine = new ClassificationRuleEngine();
  const result = engine.evaluate({ resourceType: "" });
  assert.equal(result.tier, DataClassification.CONFIDENTIAL);
});

test("tenant override CAN raise a tier above the platform default", () => {
  const engine = new ClassificationRuleEngine();
  // "team" is platform-INTERNAL by default.
  const result = engine.evaluate({ resourceType: "team" }, [{ resourceType: "team", tier: DataClassification.RESTRICTED }]);
  assert.equal(result.tier, DataClassification.RESTRICTED);
  assert.equal(result.matchedRule, "tenant-override:team");
});

test("tenant override CANNOT lower a tier below the platform default", () => {
  const engine = new ClassificationRuleEngine();
  // "health_record" is platform-RESTRICTED; an override trying to
  // downgrade it to PUBLIC must be ignored, not honored.
  const result = engine.evaluate({ resourceType: "health_record" }, [{ resourceType: "health_record", tier: DataClassification.PUBLIC }]);
  assert.equal(result.tier, DataClassification.RESTRICTED);
  assert.notEqual(result.matchedRule, "tenant-override:health_record");
});

test("tenant override for an unrelated resourceType does not affect this payload", () => {
  const engine = new ClassificationRuleEngine();
  const result = engine.evaluate({ resourceType: "team" }, [{ resourceType: "some_other_type", tier: DataClassification.RESTRICTED }]);
  assert.equal(result.tier, DataClassification.INTERNAL);
});
