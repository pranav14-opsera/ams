import { test } from "node:test";
import assert from "node:assert/strict";
import { DataClassificationTagger } from "../../src/classification/data-classification-tagger";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";
import { PhiScrubberPipelineStage } from "../../src/phi-scrubber/phi-scrubber-pipeline-stage";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";

// System integration test (acceptance criteria: "an event with PHI enters
// the ingestion pipeline, passes through the tagger and scrubber, and
// arrives in Kafka with all PHI replaced by [MASKED]"). Real
// DataClassificationTagger + PhiScrubberPipelineStage wiring, a mock
// publish function standing in for the not-yet-built Kafka producer (see
// phi-scrubber-pipeline-stage.ts's header comment for why).
//
// The separate acceptance-criteria claim about real HTTP responses
// (success + error paths) never containing PHI is covered by
// phi-error-scrubber.interceptor.test.ts against real CallHandler/
// HttpException-shaped inputs — the same code path a real HTTP request
// exercises, without needing a live NestJS HTTP server in this file.
test("end-to-end ingestion path: PHI event -> tagger -> scrubber -> mock Kafka publish arrives fully masked", () => {
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());
  const scrubberStage = new PhiScrubberPipelineStage(new PhiScrubberService());

  const publishedMessages: unknown[] = [];
  const mockKafkaProducer = { send: (message: unknown) => publishedMessages.push(message) };

  // The actual ingestion path this WO describes: Tenant Context Enricher
  // (already applied — tenantId is on the event) -> Tagger -> Scrubber ->
  // Kafka publish.
  const rawEvent = {
    tenantId: "tenant-a",
    resourceType: "health_record",
    fields: { patient_id: "12345", ssn: "123-45-6789", note: "routine checkup, no concerns" },
  };
  const tagged = tagger.tag(rawEvent);
  const scrubbed = scrubberStage.process(tagged);
  mockKafkaProducer.send(scrubbed);

  assert.equal(publishedMessages.length, 1);
  const published = publishedMessages[0] as typeof scrubbed;
  assert.equal(published.data_classification, "restricted");
  assert.equal(published.phi_scrubbed, true);
  assert.deepEqual(published.fields, { patient_id: "[MASKED]", ssn: "[MASKED]", note: "routine checkup, no concerns" });
});

test("a non-RESTRICTED/CONFIDENTIAL event is published unscrubbed (only sensitive tiers are scrubbed)", () => {
  const tagger = new DataClassificationTagger(new ClassificationRuleEngine());
  const scrubberStage = new PhiScrubberPipelineStage(new PhiScrubberService());

  const tagged = tagger.tag({ tenantId: "tenant-a", resourceType: "system_status", fields: { uptime_seconds: 12345 } });
  const scrubbed = scrubberStage.process(tagged);

  assert.equal(scrubbed.data_classification, "public");
  assert.equal(scrubbed.phi_scrubbed, false);
  assert.deepEqual(scrubbed.fields, { uptime_seconds: 12345 });
});
