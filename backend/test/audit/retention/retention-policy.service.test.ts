import { test } from "node:test";
import assert from "node:assert/strict";
import { RetentionPolicyService } from "../../../src/audit/retention/retention-policy.service";
import type { RetentionPolicy } from "../../../src/audit/retention/retention-policy.repository";

function fakeRepository(overrides: Partial<{ findByTenant: any; upsert: any; findOne: any }> = {}) {
  return {
    findByTenant: overrides.findByTenant ?? (async () => []),
    upsert: overrides.upsert ?? (async (input: any) => ({ ...input, previousRetentionDays: null, policyChangedAt: null, createdAt: new Date(), updatedAt: new Date() })),
    findOne: overrides.findOne ?? (async () => null),
  } as any;
}

function fakeAuditService() {
  const recorded: any[] = [];
  return { recorded, recordEvent: async (event: any) => void recorded.push(event) } as any;
}

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    tenantId: "t1",
    dataCategory: "audit_logs",
    retentionDays: 2555,
    previousRetentionDays: null,
    policyChangedAt: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

test("list() fills in every data category with the platform default when the tenant has no configured policy", async () => {
  const service = new RetentionPolicyService(fakeRepository(), fakeAuditService());
  const policies = await service.list("t1");
  assert.equal(policies.length, 3);
  assert.deepEqual(
    policies.map((p) => p.dataCategory).sort(),
    ["audit_logs", "execution_traces", "usage_metrics"],
  );
  assert.equal(policies.find((p) => p.dataCategory === "audit_logs")!.retentionDays, 2555);
});

test("upsert() rejects a retentionDays below the category's minimum bound", async () => {
  const service = new RetentionPolicyService(fakeRepository(), fakeAuditService());
  await assert.rejects(() => service.upsert("t1", "audit_logs", 30, "user-1"), /between 365 and 3650/);
});

test("upsert() rejects a retentionDays above the category's maximum bound", async () => {
  const service = new RetentionPolicyService(fakeRepository(), fakeAuditService());
  await assert.rejects(() => service.upsert("t1", "audit_logs", 5000, "user-1"), /between 365 and 3650/);
});

test("upsert() accepts a value within bounds and records a retention.policy_changed audit event when the value actually changes", async () => {
  const auditService = fakeAuditService();
  const repository = fakeRepository({
    findOne: async () => policy({ retentionDays: 2555 }),
    upsert: async (input: any) => policy({ retentionDays: input.retentionDays }),
  });
  const service = new RetentionPolicyService(repository, auditService);

  await service.upsert("t1", "audit_logs", 3000, "user-1");
  assert.equal(auditService.recorded.length, 1);
  assert.equal(auditService.recorded[0].action, "retention.policy_changed");
  assert.equal(auditService.recorded[0].details.previousRetentionDays, 2555);
  assert.equal(auditService.recorded[0].details.newRetentionDays, 3000);
});

test("upsert() does NOT record an audit event when the value is unchanged", async () => {
  const auditService = fakeAuditService();
  const repository = fakeRepository({
    findOne: async () => policy({ retentionDays: 2555 }),
    upsert: async (input: any) => policy({ retentionDays: input.retentionDays }),
  });
  const service = new RetentionPolicyService(repository, auditService);

  await service.upsert("t1", "audit_logs", 2555, "user-1");
  assert.equal(auditService.recorded.length, 0);
});

test("effectiveRetentionDays: a lengthening applies immediately", () => {
  const service = new RetentionPolicyService(fakeRepository(), fakeAuditService());
  const p = policy({ retentionDays: 3000, previousRetentionDays: 2555, policyChangedAt: new Date() });
  assert.equal(service.effectiveRetentionDays(p), 3000);
});

test("effectiveRetentionDays: a shortening within the 30-day grace period still uses the OLD (longer) value", () => {
  const service = new RetentionPolicyService(fakeRepository(), fakeAuditService());
  const p = policy({ retentionDays: 400, previousRetentionDays: 2555, policyChangedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
  assert.equal(service.effectiveRetentionDays(p), 2555);
});

test("effectiveRetentionDays: a shortening applies once the 30-day grace period has fully elapsed", () => {
  const service = new RetentionPolicyService(fakeRepository(), fakeAuditService());
  const p = policy({ retentionDays: 400, previousRetentionDays: 2555, policyChangedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) });
  assert.equal(service.effectiveRetentionDays(p), 400);
});

test("effectiveRetentionDays: a policy that was never changed just uses retentionDays directly", () => {
  const service = new RetentionPolicyService(fakeRepository(), fakeAuditService());
  const p = policy({ retentionDays: 2555, previousRetentionDays: null, policyChangedAt: null });
  assert.equal(service.effectiveRetentionDays(p), 2555);
});
