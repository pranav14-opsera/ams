import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthMetricsPublisherService } from "../../src/dashboard/health-metrics-publisher.service";

class FakeRepository {
  public refreshed = false;
  async refreshHealthAggregate() {
    this.refreshed = true;
  }
  async withTenantScope(_tenantId: string, fn: (client: undefined) => Promise<unknown>) {
    return fn(undefined);
  }
}

class FakeDashboardService {
  public lastQuery: unknown;
  async getFleetHealth(_client: unknown, _ctx: unknown, query: unknown) {
    this.lastQuery = query;
    return { summary: {}, agents: [], total: 0, limit: 0, offset: 0, servedFromCache: false };
  }
}

class FakePubSub {
  public published: unknown[] = [];
  async publish(tenantId: string, channel: string, message: unknown) {
    this.published.push({ tenantId, channel, message });
  }
}

test("publishUpdate refreshes the aggregate, then queries with a limit well above the 500-agent scaling target", async () => {
  const repository = new FakeRepository();
  const dashboardService = new FakeDashboardService();
  const pubsub = new FakePubSub();
  const publisher = new HealthMetricsPublisherService(repository as any, dashboardService as any, pubsub as any);

  await publisher.publishUpdate(undefined, "tenant-a");

  assert.equal(repository.refreshed, true);
  assert.ok((dashboardService.lastQuery as { limit?: number }).limit! > 500, "the live fleet snapshot query must not be capped below this WO's own 500+ agent scaling target");
});

test("publishUpdate publishes the fetched snapshot to the tenant's health channel", async () => {
  const repository = new FakeRepository();
  const dashboardService = new FakeDashboardService();
  const pubsub = new FakePubSub();
  const publisher = new HealthMetricsPublisherService(repository as any, dashboardService as any, pubsub as any);

  await publisher.publishUpdate(undefined, "tenant-a");

  assert.equal(pubsub.published.length, 1);
  assert.equal((pubsub.published[0] as { tenantId: string }).tenantId, "tenant-a");
  assert.equal((pubsub.published[0] as { channel: string }).channel, "health");
});

test("publishUpdate never throws when the underlying query fails — it logs and swallows the error", async () => {
  const repository = new FakeRepository();
  const dashboardService = {
    getFleetHealth: async () => {
      throw new Error("simulated failure");
    },
  };
  const pubsub = new FakePubSub();
  const publisher = new HealthMetricsPublisherService(repository as any, dashboardService as any, pubsub as any);

  await publisher.publishUpdate(undefined, "tenant-a");
  assert.equal(pubsub.published.length, 0);
});
