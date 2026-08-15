import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AlertThresholdService } from "../../src/alerts/alert-threshold.service";
import { DEFAULT_THRESHOLDS } from "../../src/alerts/alert-threshold.types";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";

function makeThreshold(overrides: Record<string, unknown> = {}) {
  return {
    id: "threshold-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    metricName: "error_rate",
    warningThreshold: 0.03,
    criticalThreshold: 0.05,
    cooldownSeconds: 300,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

class FakeRepository {
  public created: unknown[] = [];
  public existing: ReturnType<typeof makeThreshold> | null = makeThreshold();
  public shouldThrowOnCreate = false;

  async create(_client: unknown, tenantId: string, agentId: string, fields: Record<string, unknown>) {
    if (this.shouldThrowOnCreate) throw new Error("duplicate key value violates unique constraint");
    const row = makeThreshold({ tenantId, agentId, ...fields });
    this.created.push(row);
    return row;
  }
  async findByAgentId() {
    return this.existing ? [this.existing] : [];
  }
  async findOne() {
    return this.existing;
  }
  async update(_client: unknown, _tenantId: string, _id: string, fields: Record<string, unknown>) {
    if (!this.existing) return null;
    this.existing = { ...this.existing, ...fields };
    return this.existing;
  }
  async delete() {
    return this.existing !== null;
  }
}

function buildRig() {
  const repository = new FakeRepository();
  const auditService = new InMemoryAuditService();
  const service = new AlertThresholdService(repository as any, auditService);
  return { repository, auditService, service };
}

test("create rejects warningThreshold >= criticalThreshold", async () => {
  const { service } = buildRig();
  await assert.rejects(
    () => service.create(undefined, "tenant-a", "user-1", { agentId: "agent-1", metricName: "error_rate", warningThreshold: 0.05, criticalThreshold: 0.05 } as any),
    BadRequestException,
  );
});

test("create rejects negative threshold values", async () => {
  const { service } = buildRig();
  await assert.rejects(
    () => service.create(undefined, "tenant-a", "user-1", { agentId: "agent-1", metricName: "error_rate", warningThreshold: -1, criticalThreshold: 0.05 } as any),
    BadRequestException,
  );
});

test("create succeeds and records an audit event with actor/agentId/new value", async () => {
  const { service, auditService } = buildRig();
  const created = await service.create(undefined, "tenant-a", "user-1", { agentId: "agent-1", metricName: "error_rate", warningThreshold: 0.03, criticalThreshold: 0.05 } as any);

  assert.equal(created.metricName, "error_rate");
  assert.equal(auditService.events.length, 1);
  assert.equal(auditService.events[0].action, "alert_threshold.created");
  assert.equal(auditService.events[0].actorId, "user-1");
  assert.equal((auditService.events[0].details as any).agentId, "agent-1");
});

test("update rejects a change that would make warning >= critical", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.update(undefined, "tenant-a", "user-1", "threshold-1", { warningThreshold: 0.9 }), BadRequestException);
});

test("update on a nonexistent threshold throws NotFoundException", async () => {
  const { repository, service } = buildRig();
  repository.existing = null;
  await assert.rejects(() => service.update(undefined, "tenant-a", "user-1", "missing-id", { warningThreshold: 0.01 }), NotFoundException);
});

test("update records an audit event with previous AND new values", async () => {
  const { service, auditService } = buildRig();
  await service.update(undefined, "tenant-a", "user-1", "threshold-1", { criticalThreshold: 0.1 });

  assert.equal(auditService.events.length, 1);
  assert.equal(auditService.events[0].action, "alert_threshold.updated");
  const details = auditService.events[0].details as any;
  assert.equal(details.previousValue.criticalThreshold, 0.05);
  assert.equal(details.newValue.criticalThreshold, 0.1);
});

test("delete on a nonexistent threshold throws NotFoundException", async () => {
  const { repository, service } = buildRig();
  repository.existing = null;
  await assert.rejects(() => service.delete(undefined, "tenant-a", "user-1", "missing-id"), NotFoundException);
});

test("delete records an audit event with the previous value and a null new value", async () => {
  const { service, auditService } = buildRig();
  await service.delete(undefined, "tenant-a", "user-1", "threshold-1");

  assert.equal(auditService.events[0].action, "alert_threshold.deleted");
  const details = auditService.events[0].details as any;
  assert.equal(details.newValue, null);
  assert.ok(details.previousValue);
});

test("applyDefaultThresholds creates one threshold per default metric", async () => {
  const { repository, service } = buildRig();
  await service.applyDefaultThresholds(undefined, "tenant-a", "agent-new");

  assert.equal(repository.created.length, Object.keys(DEFAULT_THRESHOLDS).length);
});

test("applyDefaultThresholds swallows a per-metric conflict rather than aborting the whole batch", async () => {
  const { repository, service } = buildRig();
  repository.shouldThrowOnCreate = true;
  await assert.doesNotReject(() => service.applyDefaultThresholds(undefined, "tenant-a", "agent-new"));
  assert.equal(repository.created.length, 0);
});
