import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { KafkaCircuitBreakerProducerService } from "../../src/adapters/kafka/kafka-circuit-breaker-producer.service";
import type { CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";

function fakeEvent(overrides: Partial<CanonicalTelemetryEvent> = {}): CanonicalTelemetryEvent {
  return {
    event_id: randomUUID(),
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: "metric" as any,
    latency_ms: 1,
    error_rate: 0,
    token_consumption: 1,
    tool_call_success: null,
    tool_call_name: null,
    framework_type: "generic_rest",
    adapter_version: "1.0.0",
    raw_payload_hash: "a".repeat(64),
    metadata: {},
    ...overrides,
  };
}

function fakeProducer(behavior: () => Promise<void>) {
  const calls: CanonicalTelemetryEvent[] = [];
  return { calls, publish: async (event: CanonicalTelemetryEvent) => { calls.push(event); await behavior(); } } as any;
}

test("stays closed and delegates directly to the producer while publishes succeed", async () => {
  const producer = fakeProducer(async () => undefined);
  const breaker = new KafkaCircuitBreakerProducerService(producer);
  await breaker.publish(fakeEvent());
  assert.equal(breaker.getState(), "closed");
  assert.equal(producer.calls.length, 1);
});

test("opens the circuit after exactly 3 consecutive failures, not before", async () => {
  const producer = fakeProducer(async () => {
    throw new Error("broker down");
  });
  const breaker = new KafkaCircuitBreakerProducerService(producer);

  await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(breaker.getState(), "closed");
  await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(breaker.getState(), "closed");
  await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(breaker.getState(), "open");
});

test("while open, publish() fails fast WITHOUT calling the underlying producer, and buffers the event", async () => {
  const producer = fakeProducer(async () => {
    throw new Error("broker down");
  });
  const breaker = new KafkaCircuitBreakerProducerService(producer);
  for (let i = 0; i < 3; i++) await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(breaker.getState(), "open");

  const callsBefore = producer.calls.length;
  await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(producer.calls.length, callsBefore, "the underlying producer must not be called at all while the circuit is open (fast fail)");
  assert.equal(breaker.bufferedCount, 4);
});

test("after the 5-second reset window, the next publish() probes Kafka once (half-open); success closes the circuit and flushes the buffer", async () => {
  let shouldFail = true;
  const producer = fakeProducer(async () => {
    if (shouldFail) throw new Error("broker down");
  });
  const breaker = new KafkaCircuitBreakerProducerService(producer);
  for (let i = 0; i < 3; i++) await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(breaker.getState(), "open");
  assert.equal(breaker.bufferedCount, 3);

  await new Promise((resolve) => setTimeout(resolve, 5100));
  shouldFail = false;

  const callsBefore = producer.calls.length;
  await breaker.publish(fakeEvent());
  assert.equal(breaker.getState(), "closed");
  // The probe event + the 3 buffered events, all flushed through the real producer.
  assert.equal(producer.calls.length, callsBefore + 1 + 3);
  assert.equal(breaker.bufferedCount, 0);
});

test("a failed half-open probe re-opens the circuit", async () => {
  const producer = fakeProducer(async () => {
    throw new Error("still down");
  });
  const breaker = new KafkaCircuitBreakerProducerService(producer);
  for (let i = 0; i < 3; i++) await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(breaker.getState(), "open");

  await new Promise((resolve) => setTimeout(resolve, 5100));
  await assert.rejects(() => breaker.publish(fakeEvent()));
  assert.equal(breaker.getState(), "open", "a failed probe must re-open the circuit, not leave it half-open or closed");
});

test("every publish() failure still rejects (propagates to the caller) so the pipeline's own dead-letter fallback still runs", async () => {
  const producer = fakeProducer(async () => {
    throw new Error("broker down");
  });
  const breaker = new KafkaCircuitBreakerProducerService(producer);
  await assert.rejects(() => breaker.publish(fakeEvent()));
  await assert.rejects(() => breaker.publish(fakeEvent()));
  await assert.rejects(() => breaker.publish(fakeEvent())); // opens here
  await assert.rejects(() => breaker.publish(fakeEvent())); // fails fast while open — still rejects
});
