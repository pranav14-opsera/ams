import { test } from "node:test";
import assert from "node:assert/strict";
import { TelemetrySchemaValidatorService } from "../../src/adapters/telemetry-schema-validator.service";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import * as fixtures from "./fixtures/telemetry-payloads";

const FRAMEWORKS = ["LANGCHAIN", "CREWAI", "AUTOGEN", "GENERIC_REST"] as const;

test("every framework's VALID canonical fixture passes schema validation", () => {
  const validator = new TelemetrySchemaValidatorService();
  for (const framework of FRAMEWORKS) {
    const event = (fixtures as any)[`${framework}_VALID_CANONICAL`];
    const result = validator.validate(event);
    assert.equal(result.valid, true, `${framework}'s valid fixture must pass schema validation: ${result.errors.join("; ")}`);
  }
});

test("every framework's INVALID canonical fixture fails schema validation", () => {
  const validator = new TelemetrySchemaValidatorService();
  for (const framework of FRAMEWORKS) {
    const event = (fixtures as any)[`${framework}_INVALID_CANONICAL`];
    const result = validator.validate(event);
    assert.equal(result.valid, false, `${framework}'s invalid fixture must fail schema validation`);
  }
});

test("every framework's PHI-containing fixture has its PHI masked by the scrubber", () => {
  const scrubber = new PhiScrubberService();
  for (const framework of FRAMEWORKS) {
    const event = (fixtures as any)[`${framework}_PHI_CANONICAL`];
    const scrubbedMetadata = scrubber.scrub(event.metadata) as Record<string, unknown>;
    for (const value of Object.values(event.metadata)) {
      assert.ok(!Object.values(scrubbedMetadata).includes(value), `${framework}'s PHI value must not survive scrubbing unmasked`);
    }
  }
});

test("raw (pre-adapter-translation) samples exist for all 4 framework types, for future WO-035/036/037/038 adapters to translate", () => {
  assert.ok(fixtures.LANGCHAIN_RAW_SAMPLE);
  assert.ok(fixtures.CREWAI_RAW_SAMPLE);
  assert.ok(fixtures.AUTOGEN_RAW_SAMPLE);
  assert.ok(fixtures.GENERIC_REST_RAW_SAMPLE);
});
