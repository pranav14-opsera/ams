import { test } from "node:test";
import assert from "node:assert/strict";
import { handlingRuleFor } from "../../src/classification/classification-handling-rules";
import { DataClassification } from "../../src/classification/data-classification.enum";

test("PUBLIC/INTERNAL: platform KMS, no extra access control", () => {
  for (const tier of [DataClassification.PUBLIC, DataClassification.INTERNAL]) {
    const rule = handlingRuleFor(tier);
    assert.equal(rule.encryptionTarget, "platform_kms");
    assert.deepEqual(rule.accessControlRequirements, []);
  }
});

test("CONFIDENTIAL: platform KMS but requires MFA step-up", () => {
  const rule = handlingRuleFor(DataClassification.CONFIDENTIAL);
  assert.equal(rule.encryptionTarget, "platform_kms");
  assert.ok(rule.accessControlRequirements.includes("mfa_step_up"));
});

test("RESTRICTED: BYOK encryption, minimum-necessary auth, and human approval for agent access", () => {
  const rule = handlingRuleFor(DataClassification.RESTRICTED);
  assert.equal(rule.encryptionTarget, "byok");
  assert.ok(rule.accessControlRequirements.includes("minimum_necessary_authorization"));
  assert.ok(rule.accessControlRequirements.includes("human_approval_for_agent_access"));
  assert.equal(rule.auditLevel, "full_detail_required_approval");
});

test("handling rules are frozen and cannot be mutated at runtime", () => {
  const rule = handlingRuleFor(DataClassification.RESTRICTED);
  assert.ok(Object.isFrozen(rule), "the handling rule object itself must be frozen");
  assert.ok(Object.isFrozen(rule.accessControlRequirements), "nested arrays must be frozen too, not just the top-level object");

  // Assignment is a silent no-op under non-strict-mode execution (which
  // this repo's tsx-based test runner may or may not apply strict mode
  // for) rather than reliably throwing everywhere — Object.isFrozen above
  // is the real, portable guarantee; this just double-checks the value
  // genuinely didn't change regardless of throw semantics.
  (rule as { encryptionTarget: string }).encryptionTarget = "platform_kms";
  assert.equal(rule.encryptionTarget, "byok", "mutation must not have taken effect");
});

test("retention increases monotonically with sensitivity", () => {
  const tiers = [DataClassification.PUBLIC, DataClassification.INTERNAL, DataClassification.CONFIDENTIAL, DataClassification.RESTRICTED];
  const retentions = tiers.map((t) => handlingRuleFor(t).retentionDays);
  for (let i = 1; i < retentions.length; i++) {
    assert.ok(retentions[i] >= retentions[i - 1], `retention must not decrease from ${tiers[i - 1]} to ${tiers[i]}`);
  }
});
