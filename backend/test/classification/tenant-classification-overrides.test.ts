import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTenantClassificationOverrides } from "../../src/classification/tenant-classification-overrides";
import { DataClassification } from "../../src/classification/data-classification.enum";

test("loads valid overrides from a tenant's settings JSONB", () => {
  const overrides = loadTenantClassificationOverrides({
    classificationOverrides: [{ resourceType: "custom_report", tier: "restricted" }],
  });
  assert.deepEqual(overrides, [{ resourceType: "custom_report", tier: DataClassification.RESTRICTED }]);
});

test("returns an empty array when settings has no classificationOverrides key", () => {
  assert.deepEqual(loadTenantClassificationOverrides({}), []);
  assert.deepEqual(loadTenantClassificationOverrides(null), []);
  assert.deepEqual(loadTenantClassificationOverrides(undefined), []);
});

test("drops malformed entries instead of throwing", () => {
  const overrides = loadTenantClassificationOverrides({
    classificationOverrides: [
      { resourceType: "valid_one", tier: "confidential" },
      { resourceType: "missing_tier" },
      { tier: "restricted" }, // missing resourceType
      { resourceType: "bad_tier", tier: "super_secret" }, // not a real tier
      "not even an object",
      null,
    ],
  });
  assert.deepEqual(overrides, [{ resourceType: "valid_one", tier: DataClassification.CONFIDENTIAL }]);
});

test("returns an empty array when classificationOverrides itself is not an array", () => {
  assert.deepEqual(loadTenantClassificationOverrides({ classificationOverrides: "not-an-array" }), []);
});
