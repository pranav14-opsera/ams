import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { PhiSecondaryValidator } from "../../src/phi-scrubber/phi-secondary-validator";

// WO-043 AC: "PHI scrubbing adds no more than 50ms to the per-event
// processing latency (measured at P99)." Measures the full cost this
// WO adds per event — primary scrub, embedded-text scrub, and the
// secondary validation re-scan — against a realistically-sized metadata
// payload, over enough iterations for a meaningful P99.
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

test("WO-043: PHI scrubbing (primary + embedded-text + secondary validation) adds no more than 50ms at P99", () => {
  const scrubber = new PhiScrubberService();
  const validator = new PhiSecondaryValidator(scrubber);

  const metadata = {
    patient_name: "Jane Doe",
    mrn: "AB1234567",
    dob: "1990-01-01",
    diagnosis: "hypertension",
    note: "Patient called regarding follow-up; SSN 123-45-6789 confirmed for identity verification. Contact email jane.doe@example.com, phone (555) 123-4567.",
    encounter: {
      provider_notes: "Routine visit, ICD-10 code Z00.00 assigned.",
      tags: ["routine", "follow-up", "1990-01-01"],
    },
    non_phi_fields: { agent_name: "billing-agent", framework: "langchain", amount: 42.5 },
  };

  const ITERATIONS = 500;
  const durationsMs: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();

    const { result: fieldScrubbed } = scrubber.scrubWithDetections(metadata);
    const serialized = JSON.stringify(fieldScrubbed);
    const fullyScrubbedSerialized = scrubber.scrubText(serialized);
    const fullyScrubbed = JSON.parse(fullyScrubbedSerialized) as Record<string, unknown>;
    validator.hasResidualPhi(fullyScrubbed);

    const end = process.hrtime.bigint();
    durationsMs.push(Number(end - start) / 1_000_000);
  }

  durationsMs.sort((a, b) => a - b);
  const p99 = percentile(durationsMs, 0.99);

  assert.ok(p99 <= 50, `P99 PHI-scrubbing latency was ${p99.toFixed(3)}ms, exceeding the 50ms budget`);
});
