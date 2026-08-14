import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import fixtures from "../fixtures/phi-scrubber/phi-payloads.json";

test("masks PHI fields identified by field name", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expected } of fixtures.field_name_matches) {
    assert.deepEqual(scrubber.scrub(input), expected, JSON.stringify(input));
  }
});

test("masks values matching a PHI shape (SSN/DOB) regardless of field name", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expected } of fixtures.value_pattern_matches_regardless_of_field_name) {
    assert.deepEqual(scrubber.scrub(input), expected, JSON.stringify(input));
  }
});

test("non-PHI payloads pass through completely unchanged", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expected } of fixtures.non_phi_passes_through_unchanged) {
    assert.deepEqual(scrubber.scrub(input), expected);
  }
});

test("scrubs PHI in nested objects", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expected } of fixtures.nested_object) {
    assert.deepEqual(scrubber.scrub(input), expected);
  }
});

test("scrubs PHI inside arrays of objects", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expected } of fixtures.array_of_objects) {
    assert.deepEqual(scrubber.scrub(input), expected);
  }
});

test("mixed PHI/non-PHI payloads: only the PHI fields are masked", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expected } of fixtures.mixed_phi_and_non_phi) {
    assert.deepEqual(scrubber.scrub(input), expected);
  }
});

test("edge cases: empty object, null/number values on PHI-named fields", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expected } of fixtures.edge_cases) {
    assert.deepEqual(scrubber.scrub(input), expected, JSON.stringify(input));
  }
});

test("does not mutate the original input object", () => {
  const scrubber = new PhiScrubberService();
  const input = { patient_id: "12345", note: "unchanged" };
  const inputCopy = JSON.parse(JSON.stringify(input));
  scrubber.scrub(input);
  assert.deepEqual(input, inputCopy, "scrub() must not mutate its input");
});

test("scrubText masks PHI-shaped substrings inside unstructured log text", () => {
  const scrubber = new PhiScrubberService();
  for (const { input, expectedContains, expectedNotContains } of fixtures.unstructured_log_text) {
    const result = scrubber.scrubText(input);
    assert.ok(result.includes(expectedContains), result);
    assert.ok(!result.includes(expectedNotContains), result);
  }
});

test("scrubText masks multiple PHI occurrences in the same string", () => {
  const scrubber = new PhiScrubberService();
  const result = scrubber.scrubText("SSN 111-22-3333 and also 444-55-6666");
  assert.equal(result, "SSN [MASKED] and also [MASKED]");
});

test("tenant-specific field name overrides are honored on top of platform defaults", () => {
  const scrubber = new PhiScrubberService();
  const tenantSettings = { phiFieldNamePatterns: ["insured_party_id"] };
  const result = scrubber.scrub({ insured_party_id: "IP-9999", patient_id: "12345" }, tenantSettings);
  assert.deepEqual(result, { insured_party_id: "[MASKED]", patient_id: "[MASKED]" });
});

test("an invalid tenant override regex is skipped without breaking scrubbing for the rest of the payload", () => {
  const scrubber = new PhiScrubberService();
  const tenantSettings = { phiFieldNamePatterns: ["(unclosed", "insured_party_id"] };
  const result = scrubber.scrub({ insured_party_id: "IP-9999" }, tenantSettings);
  assert.deepEqual(result, { insured_party_id: "[MASKED]" });
});

test("deeply nested structures beyond normal depth still terminate (no infinite recursion)", () => {
  const scrubber = new PhiScrubberService();
  let deep: any = { patient_id: "12345" };
  for (let i = 0; i < 30; i++) {
    deep = { child: deep };
  }
  // Must not throw / hang — exact masking behavior past MAX_DEPTH is
  // secondary to the primary guarantee that it terminates.
  assert.doesNotThrow(() => scrubber.scrub(deep));
});
