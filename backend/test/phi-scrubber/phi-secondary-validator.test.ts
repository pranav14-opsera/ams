import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { PhiSecondaryValidator } from "../../src/phi-scrubber/phi-secondary-validator";

test("WO-043: reports no residual PHI for output that has already been correctly scrubbed", () => {
  const validator = new PhiSecondaryValidator(new PhiScrubberService());
  const scrubbed = { ssn: "[MASKED]", note: "call back tomorrow" };
  assert.equal(validator.hasResidualPhi(scrubbed), false);
});

test("WO-043: reports residual PHI when a value-shaped field survived the primary pass", () => {
  const validator = new PhiSecondaryValidator(new PhiScrubberService());
  // Simulates a gap in the primary pass — e.g. a field the primary scrub
  // for some reason skipped — landing here still PHI-shaped.
  const notFullyScrubbed = { note: "123-45-6789" };
  assert.equal(validator.hasResidualPhi(notFullyScrubbed), true);
});

test("WO-043: reports residual PHI when a PHI-named field survived the primary pass", () => {
  const validator = new PhiSecondaryValidator(new PhiScrubberService());
  // "diagnosis" matches the field-name pattern regardless of its value's
  // shape (unlike "ssn", whose \bssn\b pattern requires a word boundary
  // that an underscore-joined field name like "patient_ssn" doesn't have).
  const notFullyScrubbed = { diagnosis: "not actually redacted" };
  assert.equal(validator.hasResidualPhi(notFullyScrubbed), true);
});

test("WO-043: reports residual PHI for PHI embedded in free text, not just structured fields", () => {
  const validator = new PhiSecondaryValidator(new PhiScrubberService());
  const notFullyScrubbed = { error: "lookup failed for patient SSN 123-45-6789" };
  assert.equal(validator.hasResidualPhi(notFullyScrubbed), true);
});

test("WO-043: honors tenant-specific field name overrides the same way the primary scrubber does", () => {
  const validator = new PhiSecondaryValidator(new PhiScrubberService());
  const tenantSettings = { phiFieldNamePatterns: ["insured_party_id"] };
  assert.equal(validator.hasResidualPhi({ insured_party_id: "IP-9999" }, tenantSettings), true);
  assert.equal(validator.hasResidualPhi({ insured_party_id: "[MASKED]" }, tenantSettings), false);
});
