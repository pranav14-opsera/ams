import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageBatcherService } from "../../src/websocket-gateway/message-batcher.service";

test("a single message flushes as a one-element batch after ~100ms", async () => {
  const batcher = new MessageBatcherService();
  const flushed: unknown[][] = [];

  batcher.enqueue("conn-1", { value: 1 }, (batch) => flushed.push(batch));
  assert.equal(flushed.length, 0, "must not flush synchronously");

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(flushed, [[{ value: 1 }]]);
});

test("multiple messages within the 100ms window are aggregated into ONE flush call", async () => {
  const batcher = new MessageBatcherService();
  const flushed: unknown[][] = [];

  batcher.enqueue("conn-2", { value: 1 }, (batch) => flushed.push(batch));
  batcher.enqueue("conn-2", { value: 2 }, (batch) => flushed.push(batch));
  batcher.enqueue("conn-2", { value: 3 }, (batch) => flushed.push(batch));

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(flushed.length, 1, "must be exactly one flush, not three — that's the whole point of batching");
  assert.deepEqual(flushed[0], [{ value: 1 }, { value: 2 }, { value: 3 }]);
});

test("an empty buffer produces no flush at all — clear() before any message arrives is a no-op", () => {
  const batcher = new MessageBatcherService();
  assert.doesNotThrow(() => batcher.clear("conn-never-used"));
  assert.equal(batcher.hasPending("conn-never-used"), false);
});

test("clear() cancels a pending flush — a disconnected connection's stale timer never fires", async () => {
  const batcher = new MessageBatcherService();
  const flushed: unknown[][] = [];

  batcher.enqueue("conn-3", { value: 1 }, (batch) => flushed.push(batch));
  assert.equal(batcher.hasPending("conn-3"), true);
  batcher.clear("conn-3");
  assert.equal(batcher.hasPending("conn-3"), false);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(flushed.length, 0, "the cleared batch must never flush");
});

test("different connections are batched completely independently", async () => {
  const batcher = new MessageBatcherService();
  const flushedA: unknown[][] = [];
  const flushedB: unknown[][] = [];

  batcher.enqueue("conn-a", { from: "a" }, (batch) => flushedA.push(batch));
  batcher.enqueue("conn-b", { from: "b" }, (batch) => flushedB.push(batch));

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(flushedA, [[{ from: "a" }]]);
  assert.deepEqual(flushedB, [[{ from: "b" }]]);
});

test("after a flush, enqueueing again starts a fresh batch (not appended to the already-flushed one)", async () => {
  const batcher = new MessageBatcherService();
  const flushed: unknown[][] = [];

  batcher.enqueue("conn-4", { value: 1 }, (batch) => flushed.push(batch));
  await new Promise((resolve) => setTimeout(resolve, 150));

  batcher.enqueue("conn-4", { value: 2 }, (batch) => flushed.push(batch));
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(flushed, [[{ value: 1 }], [{ value: 2 }]]);
});
