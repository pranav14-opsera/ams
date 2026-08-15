import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EmailAlertChannelService } from "../../../src/alerts/channels/email-alert-channel.service";
import { InMemoryEmailProviderService } from "../../../src/alerts/ports/in-memory/in-memory-email-provider.service";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import type { AlertEvent } from "../../../src/alerts/alert-threshold.types";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

function makeAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: "event-1",
    tenantId: `tenant-${randomUUID()}`, // unique per test so each gets its own Redis rate-limit bucket
    agentId: "agent-1",
    metricName: "error_rate",
    thresholdValue: 0.05,
    actualValue: 0.9,
    severity: "critical",
    breachTimestamp: new Date("2026-08-16T00:00:00Z"),
    detectionMethod: "threshold",
    statisticalEvidence: null,
    ...overrides,
  };
}

class FakeAgentsRepository {
  public agentName = "Claims Processor";
  async findOne() {
    return { name: this.agentName };
  }
}

function buildRig() {
  const provider = new InMemoryEmailProviderService();
  const agentsRepository = new FakeAgentsRepository();
  const channel = new EmailAlertChannelService(provider, agentsRepository as any, new PhiScrubberService());
  return { provider, agentsRepository, channel };
}

test("renders the threshold-breach template with the alert's real field values", { skip }, async () => {
  const { provider, channel } = buildRig();
  const alertEvent = makeAlertEvent();

  const result = await channel.deliver(alertEvent, { recipients: ["ops@example.com"] });

  assert.equal(result.status, "sent");
  assert.equal(provider.sent.length, 1);
  const email = provider.sent[0];
  assert.deepEqual(email.to, ["ops@example.com"]);
  assert.match(email.subject, /CRITICAL/);
  assert.match(email.html, /error_rate/);
  assert.match(email.html, /0\.9/);
  await channel.onModuleDestroy();
});

test("PHI-shaped content in the agent name is masked before it ever reaches the rendered email — verifies no PHI leaks through", { skip }, async () => {
  const { provider, agentsRepository, channel } = buildRig();
  agentsRepository.agentName = "Patient SSN 123-45-6789 handler";

  await channel.deliver(makeAlertEvent(), { recipients: ["ops@example.com"] });

  const email = provider.sent[0];
  assert.ok(!email.html.includes("123-45-6789"), "an SSN-shaped agent name must never reach the rendered email HTML");
  assert.ok(!email.subject.includes("123-45-6789"), "...or the subject line");
  await channel.onModuleDestroy();
});

test(
  "rate limiting: the 101st email within the same tenant+hour is rejected as failed",
  { skip, timeout: 20_000 },
  async () => {
    const { channel } = buildRig();
    const tenantId = `tenant-${randomUUID()}`;

    for (let i = 0; i < 100; i++) {
      const result = await channel.deliver(makeAlertEvent({ tenantId, id: `event-${i}` }), { recipients: ["ops@example.com"] });
      assert.equal(result.status, "sent", `email ${i + 1} within the 100/hour limit must succeed`);
    }

    const overLimitResult = await channel.deliver(makeAlertEvent({ tenantId, id: "event-101" }), { recipients: ["ops@example.com"] });
    assert.equal(overLimitResult.status, "failed");
    assert.match(overLimitResult.errorMessage ?? "", /rate limit/);
    await channel.onModuleDestroy();
  },
);

test("a delivery failure from the email provider is reported as 'failed' with the real error message", { skip }, async () => {
  const provider = new InMemoryEmailProviderService();
  provider.send = async () => {
    throw new Error("simulated provider outage");
  };
  const channel = new EmailAlertChannelService(provider, new FakeAgentsRepository() as any, new PhiScrubberService());

  const result = await channel.deliver(makeAlertEvent(), { recipients: ["ops@example.com"] });
  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "simulated provider outage");
  await channel.onModuleDestroy();
});
