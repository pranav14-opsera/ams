import { test } from "node:test";
import assert from "node:assert/strict";
import { DriftDetectionSchedulerService } from "../../src/drift-detection/drift-detection.scheduler.service";

class FakeQualityScoreRepository {
  public tenantIds: string[] = ["tenant-a"];
  public agentIdsByTenant = new Map<string, string[]>([["tenant-a", ["agent-1", "agent-2"]]]);
  async findDistinctTenantIdsWithEstablishedBaselines() {
    return this.tenantIds;
  }
  async findAgentIdsWithEstablishedBaselines(_client: unknown, tenantId: string) {
    return this.agentIdsByTenant.get(tenantId) ?? [];
  }
}

class FakeDriftDetectionService {
  public evaluated: string[] = [];
  public failFor = new Set<string>();
  async evaluateAgent(_client: unknown, _tenantId: string, agentId: string) {
    if (this.failFor.has(agentId)) throw new Error(`simulated failure for ${agentId}`);
    this.evaluated.push(agentId);
    return null;
  }
}

function buildRig() {
  const qualityScoreRepository = new FakeQualityScoreRepository();
  const driftDetectionService = new FakeDriftDetectionService();
  const scheduler = new DriftDetectionSchedulerService(qualityScoreRepository as any, driftDetectionService as any);
  return { qualityScoreRepository, driftDetectionService, scheduler };
}

test("runTick evaluates every agent with an established baseline, across every tenant", async () => {
  const { driftDetectionService, scheduler } = buildRig();
  await scheduler.runTick();
  assert.deepEqual(driftDetectionService.evaluated.sort(), ["agent-1", "agent-2"]);
});

test("a failure evaluating one agent doesn't stop the rest of the fleet from being evaluated", async () => {
  const { driftDetectionService, scheduler } = buildRig();
  driftDetectionService.failFor.add("agent-1");
  await scheduler.runTick();
  assert.deepEqual(driftDetectionService.evaluated, ["agent-2"]);
});

test("multiple tenants are each swept independently", async () => {
  const { qualityScoreRepository, driftDetectionService, scheduler } = buildRig();
  qualityScoreRepository.tenantIds = ["tenant-a", "tenant-b"];
  qualityScoreRepository.agentIdsByTenant.set("tenant-b", ["agent-3"]);

  await scheduler.runTick();
  assert.deepEqual(driftDetectionService.evaluated.sort(), ["agent-1", "agent-2", "agent-3"]);
});

test("a failure listing tenants entirely doesn't throw", async () => {
  const { qualityScoreRepository, scheduler } = buildRig();
  qualityScoreRepository.findDistinctTenantIdsWithEstablishedBaselines = async () => {
    throw new Error("boom");
  };
  await assert.doesNotReject(() => scheduler.runTick());
});

test("with zero tenants having any established baseline, no evaluation happens at all", async () => {
  const { qualityScoreRepository, driftDetectionService, scheduler } = buildRig();
  qualityScoreRepository.tenantIds = [];
  await scheduler.runTick();
  assert.equal(driftDetectionService.evaluated.length, 0);
});
