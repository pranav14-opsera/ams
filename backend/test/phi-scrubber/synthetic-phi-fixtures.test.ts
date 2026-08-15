import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { PhiSecondaryValidator } from "../../src/phi-scrubber/phi-secondary-validator";
import fixtures from "../fixtures/phi/synthetic-phi-events.json";

// WO-043 AC: "Synthetic PHI test fixtures (using obviously fake data like
// 'Jane Doe SSN 000-00-0000') are committed to test/fixtures/phi/ — no real
// PHI is ever used in tests." Every fixture event here exercises the same
// two-pass scrub the real pipeline uses, then the secondary validator gate.
test("every synthetic PHI fixture event is fully masked by the full two-pass scrub, with at least one detection recorded", () => {
  const scrubber = new PhiScrubberService();
  for (const event of fixtures.events) {
    const { result, detections } = scrubber.scrubWithDetections(event.metadata);
    assert.ok(detections.length > 0, `fixture "${event.name}" must produce at least one PHI detection`);

    // Some fixtures embed PHI mid-sentence (e.g. "SSN on file: 000-00-0000"),
    // which only the SECOND pass (substring-level scrubText, over the
    // already field-scrubbed output) catches — exactly the real pipeline's
    // two-pass design (WO-035).
    const fullyScrubbed = scrubber.scrubText(JSON.stringify(result));

    assert.ok(!fullyScrubbed.includes("000-00-0000"), `fixture "${event.name}": SSN must not survive scrubbing`);
    assert.ok(!fullyScrubbed.includes("TEST-MRN-12345"), `fixture "${event.name}": MRN must not survive scrubbing`);
    assert.ok(!fullyScrubbed.includes("1900-01-01"), `fixture "${event.name}": DOB must not survive scrubbing`);
    assert.ok(!fullyScrubbed.includes("test@example.com"), `fixture "${event.name}": email must not survive scrubbing`);
  }
});

test("every synthetic PHI fixture event passes the secondary validation gate (no residual PHI) after the full two-pass scrub", () => {
  const scrubber = new PhiScrubberService();
  const validator = new PhiSecondaryValidator(scrubber);
  for (const event of fixtures.events) {
    const { result: fieldScrubbed } = scrubber.scrubWithDetections(event.metadata);
    const serialized = JSON.stringify(fieldScrubbed);
    const fullyScrubbed = JSON.parse(scrubber.scrubText(serialized)) as Record<string, unknown>;

    assert.equal(validator.hasResidualPhi(fullyScrubbed), false, `fixture "${event.name}" must have zero residual PHI after the full pipeline scrub`);
  }
});
