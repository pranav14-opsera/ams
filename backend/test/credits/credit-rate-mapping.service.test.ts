import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditRateMappingService } from "../../src/credits/credit-rate-mapping.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

function uniqueTenant(): string {
  return `test-rate-${Math.random().toString(36).slice(2, 8)}`;
}

class FakeRepository {
  public rate: number | null = 5;
  public findCalls = 0;
  public hardCap: number | null = null;
  async findEffectiveRate() {
    this.findCalls++;
    return this.rate === null ? null : { id: "rate-1", tenantId: "tenant-a", actionType: "tool_call", creditsPerUnit: this.rate, effectiveFrom: new Date(), effectiveUntil: null };
  }
  async upsertRate(_client: unknown, tenantId: string, actionType: string, creditsPerUnit: number) {
    this.rate = creditsPerUnit;
    return { id: "rate-1", tenantId, actionType, creditsPerUnit, effectiveFrom: new Date(), effectiveUntil: null };
  }
  async findHardCap(_client: unknown, tenantId: string, teamId: string) {
    return this.hardCap === null ? null : { id: "limit-1", tenantId, teamId, hardCap: this.hardCap };
  }
  async upsertHardCap(_client: unknown, tenantId: string, teamId: string, hardCap: number | null) {
    this.hardCap = hardCap;
    return { id: "limit-1", tenantId, teamId, hardCap };
  }
}

test("real Redis: getRate caches the database result so a second call within the TTL never re-queries the database", { skip }, async () => {
  const repository = new FakeRepository();
  const service = new CreditRateMappingService(repository as any);
  const tenantId = uniqueTenant();
  try {
    const first = await service.getRate(undefined, tenantId, "tool_call");
    assert.equal(first, 5);
    assert.equal(repository.findCalls, 1);

    const second = await service.getRate(undefined, tenantId, "tool_call");
    assert.equal(second, 5);
    assert.equal(repository.findCalls, 1, "the second call should be served entirely from the Redis cache");
  } finally {
    await service.onModuleDestroy();
  }
});

test("real Redis: setRate invalidates the cache so the next getRate reflects the new value", { skip }, async () => {
  const repository = new FakeRepository();
  const service = new CreditRateMappingService(repository as any);
  const tenantId = uniqueTenant();
  try {
    await service.getRate(undefined, tenantId, "tool_call"); // warms the cache with rate=5
    await service.setRate(undefined, tenantId, "tool_call", 12);

    const updated = await service.getRate(undefined, tenantId, "tool_call");
    assert.equal(updated, 12);
  } finally {
    await service.onModuleDestroy();
  }
});

test("getRate returns null (not a fabricated default) when no rate is configured for this action_type at all", { skip }, async () => {
  const repository = new FakeRepository();
  repository.rate = null;
  const service = new CreditRateMappingService(repository as any);
  try {
    const rate = await service.getRate(undefined, "tenant-a", "unconfigured_action");
    assert.equal(rate, null);
  } finally {
    await service.onModuleDestroy();
  }
});

test("getHardCap/setHardCap delegate to the repository", { skip }, async () => {
  const repository = new FakeRepository();
  const service = new CreditRateMappingService(repository as any);
  try {
    assert.equal(await service.getHardCap(undefined, "tenant-a", "team-1"), null);
    await service.setHardCap(undefined, "tenant-a", "team-1", 5000);
    assert.equal(await service.getHardCap(undefined, "tenant-a", "team-1"), 5000);
  } finally {
    await service.onModuleDestroy();
  }
});
