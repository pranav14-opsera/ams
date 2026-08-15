import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BaseAgentAdapter } from "../../src/adapters/base-agent-adapter";
import type { AdapterMetadata, ConnectionValidationResult } from "../../src/adapters/interfaces/agent-adapter.interface";
import type { CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";

class TestAdapter extends BaseAgentAdapter {
  constructor(batching?: Partial<{ maxBatchSize: number; flushIntervalMs: number }>, retry?: Partial<{ maxRetries: number; baseDelayMs: number }>) {
    super(batching, retry);
  }

  async validateConnection(_config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    return { valid: true };
  }

  translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent {
    return rawEvent as CanonicalTelemetryEvent;
  }

  getAdapterMetadata(): AdapterMetadata {
    return { frameworkType: "generic_rest", adapterVersion: "test-1.0.0", supportedEventTypes: [] };
  }

  async publicRetry<T>(fn: () => Promise<T>): Promise<T> {
    return (this as any).retryWithBackoff(fn);
  }
}

function fakeEvent(): CanonicalTelemetryEvent {
  return {
    event_id: randomUUID(),
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: "metric" as any,
    latency_ms: 1,
    error_rate: 0,
    token_consumption: 1,
    tool_call_success: true,
    tool_call_name: null,
    framework_type: "generic_rest",
    adapter_version: "1.0.0",
    raw_payload_hash: "a".repeat(64),
    metadata: {},
  };
}

test("default getHealthProbe reports healthy without any override", async () => {
  const adapter = new TestAdapter();
  assert.deepEqual(await adapter.getHealthProbe(), { healthy: true });
});

test("enqueue auto-flushes once maxBatchSize is reached", async () => {
  const adapter = new TestAdapter({ maxBatchSize: 3, flushIntervalMs: 60_000 });
  const flushed: CanonicalTelemetryEvent[][] = [];
  adapter.startBatching(async (batch) => {
    flushed.push(batch);
  });

  await adapter.enqueue(fakeEvent());
  await adapter.enqueue(fakeEvent());
  assert.equal(flushed.length, 0, "must not flush before maxBatchSize is reached");
  await adapter.enqueue(fakeEvent());

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].length, 3);
  assert.equal(adapter.queuedCount, 0, "the queue must be empty immediately after an auto-flush");
  adapter.stopBatching();
});

test("startBatching's timer flushes a partial batch even under maxBatchSize", async () => {
  const adapter = new TestAdapter({ maxBatchSize: 100, flushIntervalMs: 30 });
  const flushed: CanonicalTelemetryEvent[][] = [];
  adapter.startBatching(async (batch) => {
    flushed.push(batch);
  });

  await adapter.enqueue(fakeEvent());
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].length, 1);
  adapter.stopBatching();
});

test("flush() is a no-op when the queue is empty", async () => {
  const adapter = new TestAdapter();
  let called = false;
  adapter.startBatching(async () => {
    called = true;
  });
  await adapter.flush();
  assert.equal(called, false);
  adapter.stopBatching();
});

test("stopBatching() stops the auto-flush timer", async () => {
  const adapter = new TestAdapter({ maxBatchSize: 100, flushIntervalMs: 20 });
  const flushed: CanonicalTelemetryEvent[][] = [];
  adapter.startBatching(async (batch) => {
    flushed.push(batch);
  });
  await adapter.enqueue(fakeEvent());
  adapter.stopBatching();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(flushed.length, 0, "no flush should happen after stopBatching()");
});

test("retryWithBackoff retries up to maxRetries and then succeeds", async () => {
  const adapter = new TestAdapter({}, { maxRetries: 3, baseDelayMs: 5 });
  let attempts = 0;
  const result = await adapter.publicRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error("transient failure");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("retryWithBackoff exhausts retries and propagates the final error", async () => {
  const adapter = new TestAdapter({}, { maxRetries: 2, baseDelayMs: 5 });
  let attempts = 0;
  await assert.rejects(
    () =>
      adapter.publicRetry(async () => {
        attempts++;
        throw new Error(`failure ${attempts}`);
      }),
    (err: any) => {
      assert.equal(err.message, "failure 3"); // initial attempt + 2 retries = 3 total calls
      return true;
    },
  );
  assert.equal(attempts, 3);
});
