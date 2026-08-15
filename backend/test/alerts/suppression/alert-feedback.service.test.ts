import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertFeedbackService } from "../../../src/alerts/suppression/alert-feedback.service";

class FakeFeedbackRepository {
  public submitted: unknown[] = [];
  public patternCounts = { falsePositiveCount: 0, confirmedCount: 0 };
  async submit(_client: unknown, tenantId: string, agentId: string, alertEventId: string, metricName: string, feedbackType: string, createdBy: string | null) {
    const record = { id: `feedback-${this.submitted.length + 1}`, tenantId, agentId, alertEventId, metricName, feedbackType, createdBy, createdAt: new Date() };
    this.submitted.push(record);
    return record;
  }
  async getPatternFeedback() {
    return this.patternCounts;
  }
}

class FakeEventRepository {
  public events = new Map<string, { id: string; agentId: string; metricName: string }>();
  async findById(_client: unknown, _tenantId: string, id: string) {
    return this.events.get(id) ?? null;
  }
}

class FakeAuditService {
  public events: unknown[] = [];
  async recordEvent(event: unknown) {
    this.events.push(event);
  }
}

function buildRig() {
  const feedbackRepository = new FakeFeedbackRepository();
  const eventRepository = new FakeEventRepository();
  const auditService = new FakeAuditService();
  const service = new AlertFeedbackService(feedbackRepository as any, eventRepository as any, auditService as any);
  return { feedbackRepository, eventRepository, auditService, service };
}

test("submitFeedback records feedback against the alert's own agent/metric and audits the action", async () => {
  const { feedbackRepository, eventRepository, auditService, service } = buildRig();
  eventRepository.events.set("event-1", { id: "event-1", agentId: "agent-1", metricName: "error_rate" });

  const feedback = await service.submitFeedback(undefined, "tenant-a", "user-1", "event-1", "false_positive");

  assert.equal(feedback.agentId, "agent-1");
  assert.equal(feedback.metricName, "error_rate");
  assert.equal(feedbackRepository.submitted.length, 1);
  assert.equal(auditService.events.length, 1);
  assert.equal((auditService.events[0] as any).action, "alert.feedback_submitted");
});

test("submitFeedback throws when the referenced alert event doesn't exist for this tenant", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.submitFeedback(undefined, "tenant-a", "user-1", "does-not-exist", "confirmed"));
});

test("getPatternFeedback delegates straight through to the repository", async () => {
  const { feedbackRepository, service } = buildRig();
  feedbackRepository.patternCounts = { falsePositiveCount: 4, confirmedCount: 1 };

  const counts = await service.getPatternFeedback(undefined, "tenant-a", "agent-1", "error_rate");
  assert.deepEqual(counts, { falsePositiveCount: 4, confirmedCount: 1 });
});
