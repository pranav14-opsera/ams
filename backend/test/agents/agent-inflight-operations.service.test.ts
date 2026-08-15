import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentInFlightOperationsService } from "../../src/agents/agent-inflight-operations.service";

const REDIS_URL = process.env.REDIS_URL;
const skip = !REDIS_URL;

function randomAgentId(): string {
  return `test-inflight-${Math.random().toString(36).slice(2, 10)}`;
}

test("increment/decrement track a real per-agent counter against Redis", { skip }, async () => {
  const service = new AgentInFlightOperationsService();
  const agentId = randomAgentId();
  try {
    assert.equal(await service.getCount(agentId), 0);
    assert.equal(await service.increment(agentId), 1);
    assert.equal(await service.increment(agentId), 2);
    assert.equal(await service.decrement(agentId), 1);
    assert.equal(await service.getCount(agentId), 1);
    assert.equal(await service.decrement(agentId), 0);
  } finally {
    await service.onModuleDestroy();
  }
});

test("decrement never goes negative even when unbalanced", { skip }, async () => {
  const service = new AgentInFlightOperationsService();
  const agentId = randomAgentId();
  try {
    assert.equal(await service.decrement(agentId), 0);
    assert.equal(await service.getCount(agentId), 0);
  } finally {
    await service.onModuleDestroy();
  }
});

test("waitForDrain resolves immediately (drained: true) once the counter is already 0", { skip }, async () => {
  const service = new AgentInFlightOperationsService();
  const agentId = randomAgentId();
  try {
    const result = await service.waitForDrain(agentId, 5000);
    assert.deepEqual(result, { drained: true, remainingCount: 0 });
  } finally {
    await service.onModuleDestroy();
  }
});

test("waitForDrain returns drained: true once a decrement brings the counter to 0 before the timeout", { skip }, async () => {
  const service = new AgentInFlightOperationsService();
  const agentId = randomAgentId();
  try {
    await service.increment(agentId);
    setTimeout(() => {
      service.decrement(agentId).catch(() => undefined);
    }, 150);

    const result = await service.waitForDrain(agentId, 2000, 50);
    assert.equal(result.drained, true);
    assert.equal(result.remainingCount, 0);
  } finally {
    await service.onModuleDestroy();
  }
});

test("waitForDrain returns drained: false with the remaining count once the timeout elapses", { skip }, async () => {
  const service = new AgentInFlightOperationsService();
  const agentId = randomAgentId();
  try {
    await service.increment(agentId);
    await service.increment(agentId);

    const result = await service.waitForDrain(agentId, 300, 50);
    assert.equal(result.drained, false);
    assert.equal(result.remainingCount, 2);
  } finally {
    await service.decrement(agentId);
    await service.decrement(agentId);
    await service.onModuleDestroy();
  }
});
