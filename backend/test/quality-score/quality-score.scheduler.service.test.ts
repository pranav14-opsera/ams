import { test } from "node:test";
import assert from "node:assert/strict";
import { QualityScoreSchedulerService } from "../../src/quality-score/quality-score.scheduler.service";

class FakeRepository {
  public tenantIds: string[] = ["tenant-a"];
  public agentIdsByTenant = new Map<string, string[]>([["tenant-a", ["agent-1", "agent-2"]]]);
  async findDistinctTenantIdsWithActiveAgents() {
    return this.tenantIds;
  }
  async findActiveAgentIds(_client: unknown, tenantId: string) {
    return this.agentIdsByTenant.get(tenantId) ?? [];
  }
}

class FakeService {
  public computed: string[] = [];
  public baselineChecked: string[] = [];
  public failFor: Set<string> = new Set();
  async computeAndStoreScoreForAgent(_client: unknown, _tenantId: string, agentId: string) {
    if (this.failFor.has(agentId)) throw new Error(`simulated failure for ${agentId}`);
    this.computed.push(agentId);
  }
  async checkAndEstablishBaseline(_client: unknown, _tenantId: string, agentId: string) {
    this.baselineChecked.push(agentId);
  }
}

class FakeLock {
  public held = false;
  public acquireCalls = 0;
  async acquire() {
    this.acquireCalls++;
    if (this.held) return null;
    this.held = true;
    return async () => {
      this.held = false;
    };
  }
}

function buildRig() {
  const repository = new FakeRepository();
  const service = new FakeService();
  const lock = new FakeLock();
  const scheduler = new QualityScoreSchedulerService(repository as any, service as any, lock as any);
  return { repository, service, lock, scheduler };
}

test("runTickUnlocked computes and stores a score for every active agent across every tenant", async () => {
  const { service, scheduler } = buildRig();
  await scheduler.runTickUnlocked();
  assert.deepEqual(service.computed.sort(), ["agent-1", "agent-2"]);
  assert.deepEqual(service.baselineChecked.sort(), ["agent-1", "agent-2"]);
});

test("a failure computing one agent's score doesn't stop the rest of the tenant/fleet from being processed", async () => {
  const { service, scheduler } = buildRig();
  service.failFor.add("agent-1");
  await scheduler.runTickUnlocked();
  assert.deepEqual(service.computed, ["agent-2"]);
});

test("multiple tenants are each swept independently", async () => {
  const { repository, service, scheduler } = buildRig();
  repository.tenantIds = ["tenant-a", "tenant-b"];
  repository.agentIdsByTenant.set("tenant-b", ["agent-3"]);

  await scheduler.runTickUnlocked();
  assert.deepEqual(service.computed.sort(), ["agent-1", "agent-2", "agent-3"]);
});

test("runTick acquires the distributed lock before running, and releases it afterward", async () => {
  const { lock, service, scheduler } = buildRig();
  await scheduler.runTick();
  assert.equal(lock.held, false, "lock should be released after the tick completes");
  assert.equal(service.computed.length, 2);
});

test("runTick skips the whole tick entirely if another instance already holds the lock", async () => {
  const { lock, service, scheduler } = buildRig();
  lock.held = true; // simulate another instance already holding it

  await scheduler.runTick();
  assert.equal(service.computed.length, 0);
});

test("runTick releases the lock even if the tick itself throws", async () => {
  const { repository, lock, scheduler } = buildRig();
  repository.findDistinctTenantIdsWithActiveAgents = async () => {
    throw new Error("should not propagate — runTickUnlocked catches its own top-level errors");
  };

  await scheduler.runTick();
  assert.equal(lock.held, false);
});
