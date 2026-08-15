import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuditEventBufferFullError, AuditEventProducerService } from "../../../src/audit/events/audit-event-producer.service";
import { ActorType, type CanonicalAuditEvent } from "../../../src/audit/events/canonical-audit-event";

function fakeEvent(): CanonicalAuditEvent {
  return {
    event_id: randomUUID(),
    actor_id: null,
    actor_type: ActorType.SYSTEM,
    tenant_id: randomUUID(),
    action: "test.action",
    resource_type: "test_resource",
    resource_id: null,
    data_classification: "internal",
    ip_address: null,
    change_details: {},
    correlation_id: null,
    occurred_at: new Date().toISOString(),
  };
}

function fakeKafkaProducer(behavior: "succeed" | "fail" = "succeed") {
  const published: CanonicalAuditEvent[] = [];
  let callCount = 0;
  return {
    published,
    get callCount() {
      return callCount;
    },
    publish: async (event: CanonicalAuditEvent) => {
      callCount++;
      if (behavior === "fail") throw new Error("broker unreachable");
      published.push(event);
    },
  } as any;
}

test("publish() succeeds directly when Kafka is healthy", async () => {
  const kafka = fakeKafkaProducer("succeed");
  const producer = new AuditEventProducerService(kafka);
  await producer.publish(fakeEvent());
  assert.equal(kafka.published.length, 1);
  assert.equal(producer.getState(), "closed");
});

test("publish() retries 3 times before giving up on a single event", async () => {
  const kafka = fakeKafkaProducer("fail");
  const producer = new AuditEventProducerService(kafka);
  await assert.rejects(() => producer.publish(fakeEvent()));
  assert.equal(kafka.callCount, 3, "must retry exactly 3 times per publish attempt");
});

test("the circuit opens after 3 consecutive FAILED publish() calls (each internally retried 3x) and buffers subsequent events without calling Kafka", async () => {
  const kafka = fakeKafkaProducer("fail");
  const producer = new AuditEventProducerService(kafka);

  await assert.rejects(() => producer.publish(fakeEvent()));
  await assert.rejects(() => producer.publish(fakeEvent()));
  assert.equal(producer.getState(), "closed", "2 failed calls must not yet trip the 3-failure threshold");
  await assert.rejects(() => producer.publish(fakeEvent()));
  assert.equal(producer.getState(), "open");

  const callsBefore = kafka.callCount;
  await assert.rejects(() => producer.publish(fakeEvent()));
  assert.equal(kafka.callCount, callsBefore, "while open, publish() must not call Kafka at all");
  assert.equal(producer.bufferedCount, 4);
});

test("a failed publish is buffered, and buffering is never silent — the buffer count reflects it", async () => {
  const kafka = fakeKafkaProducer("fail");
  const producer = new AuditEventProducerService(kafka);
  const event = fakeEvent();
  await assert.rejects(() => producer.publish(event));
  assert.equal(producer.bufferedCount, 1);
});

test("the buffer is bounded — once full, publish() throws AuditEventBufferFullError instead of silently dropping or evicting", async () => {
  const kafka = fakeKafkaProducer("fail");
  const producer = new AuditEventProducerService(kafka, 2);

  await assert.rejects(() => producer.publish(fakeEvent())); // buffers 1 (circuit still closed, 1 failure)
  await assert.rejects(() => producer.publish(fakeEvent())); // buffers 2, at max (circuit still closed, 2 failures)
  await assert.rejects(() => producer.publish(fakeEvent()), AuditEventBufferFullError); // 3rd call retries against Kafka again, fails, then the buffer itself rejects since it's already full
  assert.equal(producer.bufferedCount, 2, "the buffer must not exceed its configured max size");
});

test("flushBuffer() replays buffered events once Kafka recovers", async () => {
  const kafka = fakeKafkaProducer("fail");
  const producer = new AuditEventProducerService(kafka);
  await assert.rejects(() => producer.publish(fakeEvent()));
  assert.equal(producer.bufferedCount, 1);

  kafka.publish = async (event: CanonicalAuditEvent) => {
    kafka.published.push(event);
  };
  const result = await producer.flushBuffer();
  assert.equal(result.flushed, 1);
  assert.equal(result.remaining, 0);
  assert.equal(kafka.published.length, 1);
});

