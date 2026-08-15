import { test } from "node:test";
import assert from "node:assert/strict";
import { AdapterHealthService } from "../../../src/adapters/health/adapter-health.service";

function fakeConfigRepository(initial: Record<string, any>) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    findAll: async () => Array.from(rows.values()),
    findByType: async (type: string) => rows.get(type) ?? null,
    updateHealth: async (type: string, fields: any) => {
      const existing = rows.get(type);
      if (!existing) return null;
      const updated = { ...existing, health_status: fields.healthStatus, consecutive_failures: fields.consecutiveFailures, last_health_check_at: fields.lastHealthCheckAt };
      rows.set(type, updated);
      return updated;
    },
  } as any;
}

function fakeHealthCheckRepository() {
  const records: any[] = [];
  return {
    records,
    record: async (adapterType: string, status: string, responseTimeMs: number | null, errorDetails: string | null) => {
      const row = { id: String(records.length), adapter_type: adapterType, check_timestamp: new Date(), status, response_time_ms: responseTimeMs, error_details: errorDetails };
      records.push(row);
      return row;
    },
    findRecentByType: async (adapterType: string, limit = 10) => records.filter((r) => r.adapter_type === adapterType).slice(-limit).reverse(),
  } as any;
}

function fakeRegistry(adapters: Record<string, { getHealthProbe: () => Promise<{ healthy: boolean; latencyMs?: number; details?: unknown }> }>) {
  return { get: (type: string) => adapters[type] } as any;
}

function baseConfig(type: string, overrides: Record<string, unknown> = {}) {
  return {
    adapter_type: type,
    adapter_version: "1.0.0",
    supported_framework_versions: ">=1.0.0 <2.0.0",
    health_status: "healthy",
    consecutive_failures: 0,
    last_health_check_at: null,
    health_check_interval_seconds: 60,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

test("getCompatibilityMatrix returns every configured adapter's type/version/range/status", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain") });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), fakeRegistry({}));
  const matrix = await service.getCompatibilityMatrix();
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].adapterType, "langchain");
  assert.equal(matrix[0].healthStatus, "healthy");
});

test("checkVersionCompatibility returns compatible:true for a version within the supported range", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain", { supported_framework_versions: ">=0.2.0 <0.4.0" }) });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), fakeRegistry({}));
  const result = await service.checkVersionCompatibility("langchain", "0.3.5");
  assert.deepEqual(result, { compatible: true, supportedRange: ">=0.2.0 <0.4.0" });
});

test("checkVersionCompatibility returns compatible:false with a reason for a version outside the supported range", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain", { supported_framework_versions: ">=0.2.0 <0.4.0" }) });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), fakeRegistry({}));
  const result = await service.checkVersionCompatibility("langchain", "0.5.0");
  assert.equal(result.compatible, false);
  assert.ok(result.reason);
});

test("checkVersionCompatibility with a '*' range is always compatible", async () => {
  const configRepo = fakeConfigRepository({ generic_rest: baseConfig("generic_rest", { supported_framework_versions: "*" }) });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), fakeRegistry({}));
  const result = await service.checkVersionCompatibility("generic_rest", "999.999.999");
  assert.deepEqual(result, { compatible: true, supportedRange: "*" });
});

test("checkVersionCompatibility gracefully handles an unparseable version string (never throws)", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain") });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), fakeRegistry({}));
  const result = await service.checkVersionCompatibility("langchain", "not-a-version");
  assert.equal(result.compatible, false);
  assert.ok(result.reason);
});

test("checkVersionCompatibility for an unknown adapter type returns compatible:false rather than throwing", async () => {
  const service = new AdapterHealthService(fakeConfigRepository({}), fakeHealthCheckRepository(), fakeRegistry({}));
  const result = await service.checkVersionCompatibility("no_such_adapter", "1.0.0");
  assert.equal(result.compatible, false);
});

test("runHealthProbe on a healthy probe resets consecutive_failures to 0 and records a 'healthy' check", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain", { consecutive_failures: 2 }) });
  const healthCheckRepo = fakeHealthCheckRepository();
  const registry = fakeRegistry({ langchain: { getHealthProbe: async () => ({ healthy: true, latencyMs: 42 }) } });
  const service = new AdapterHealthService(configRepo, healthCheckRepo, registry);

  const result = await service.runHealthProbe("langchain");
  assert.equal(result.healthy, true);
  assert.equal(result.status, "healthy");
  assert.equal(configRepo.rows.get("langchain").consecutive_failures, 0);
  assert.equal(healthCheckRepo.records[0].status, "healthy");
});

test("runHealthProbe on failure increments consecutive_failures but stays below the degraded threshold at 1-2 failures", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain") });
  const registry = fakeRegistry({ langchain: { getHealthProbe: async () => ({ healthy: false, details: { reason: "timeout" } }) } });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), registry);

  const first = await service.runHealthProbe("langchain");
  assert.equal(first.status, "healthy");
  assert.equal(configRepo.rows.get("langchain").consecutive_failures, 1);

  const second = await service.runHealthProbe("langchain");
  assert.equal(second.status, "healthy");
  assert.equal(configRepo.rows.get("langchain").consecutive_failures, 2);
});

test("runHealthProbe transitions to 'degraded' on the 3rd consecutive failure, and becameDegraded is true exactly then", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain") });
  const registry = fakeRegistry({ langchain: { getHealthProbe: async () => ({ healthy: false, details: { reason: "timeout" } }) } });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), registry);

  await service.runHealthProbe("langchain");
  await service.runHealthProbe("langchain");
  const third = await service.runHealthProbe("langchain");

  assert.equal(third.status, "degraded");
  assert.equal(third.becameDegraded, true);
  assert.equal(configRepo.rows.get("langchain").consecutive_failures, 3);
});

test("runHealthProbe does not re-flag becameDegraded on the 4th+ consecutive failure (already degraded)", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain") });
  const registry = fakeRegistry({ langchain: { getHealthProbe: async () => ({ healthy: false }) } });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), registry);

  await service.runHealthProbe("langchain");
  await service.runHealthProbe("langchain");
  await service.runHealthProbe("langchain");
  const fourth = await service.runHealthProbe("langchain");

  assert.equal(fourth.status, "degraded");
  assert.equal(fourth.becameDegraded, false);
});

test("runHealthProbe recovers from degraded back to healthy on a successful probe", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain", { health_status: "degraded", consecutive_failures: 3 }) });
  const registry = fakeRegistry({ langchain: { getHealthProbe: async () => ({ healthy: true }) } });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), registry);

  const result = await service.runHealthProbe("langchain");
  assert.equal(result.status, "healthy");
  assert.equal(configRepo.rows.get("langchain").consecutive_failures, 0);
});

test("runHealthProbe treats an unregistered adapter as a failure, not a crash", async () => {
  const configRepo = fakeConfigRepository({ crewai: baseConfig("crewai") });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), fakeRegistry({}));
  const result = await service.runHealthProbe("crewai");
  assert.equal(result.healthy, false);
  assert.ok(result.errorDetails);
});

test("runHealthProbe treats a thrown probe (not just healthy:false) as a failure", async () => {
  const configRepo = fakeConfigRepository({ crewai: baseConfig("crewai") });
  const registry = fakeRegistry({
    crewai: {
      getHealthProbe: async () => {
        throw new Error("adapter blew up");
      },
    },
  });
  const service = new AdapterHealthService(configRepo, fakeHealthCheckRepository(), registry);
  const result = await service.runHealthProbe("crewai");
  assert.equal(result.healthy, false);
  assert.match(result.errorDetails!, /adapter blew up/);
});

test("getAdapterHealth returns the current status plus up to the last 10 checks", async () => {
  const configRepo = fakeConfigRepository({ langchain: baseConfig("langchain", { consecutive_failures: 1 }) });
  const healthCheckRepo = fakeHealthCheckRepository();
  for (let i = 0; i < 12; i++) await healthCheckRepo.record("langchain", "healthy", 10, null);
  const service = new AdapterHealthService(configRepo, healthCheckRepo, fakeRegistry({}));

  const detail = await service.getAdapterHealth("langchain");
  assert.equal(detail.consecutiveFailures, 1);
  assert.equal(detail.recentChecks.length, 10);
});

test("getAdapterHealth throws 404 for an unknown adapter type", async () => {
  const service = new AdapterHealthService(fakeConfigRepository({}), fakeHealthCheckRepository(), fakeRegistry({}));
  await assert.rejects(
    () => service.getAdapterHealth("no_such_adapter"),
    (err: any) => {
      assert.equal(err.getStatus(), 404);
      return true;
    },
  );
});
