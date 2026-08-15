import { test } from "node:test";
import assert from "node:assert/strict";
import { AdapterHealthSchedulerService } from "../../../src/adapters/health/adapter-health-scheduler.service";

function fakeConfigRepository(rows: any[]) {
  return { findAll: async () => rows } as any;
}

function fakeHealthService() {
  const probed: string[] = [];
  return { probed, runHealthProbe: async (type: string) => { probed.push(type); return {}; } } as any;
}

test("tick() probes an adapter that has never been checked before (last_health_check_at: null)", async () => {
  const healthService = fakeHealthService();
  const scheduler = new AdapterHealthSchedulerService(healthService, fakeConfigRepository([{ adapter_type: "langchain", last_health_check_at: null, health_check_interval_seconds: 60 }]));

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 5200)); // jitter is 0-5s
  assert.deepEqual(healthService.probed, ["langchain"]);
});

test("tick() skips an adapter whose interval hasn't elapsed yet", async () => {
  const healthService = fakeHealthService();
  const scheduler = new AdapterHealthSchedulerService(
    healthService,
    fakeConfigRepository([{ adapter_type: "langchain", last_health_check_at: new Date(), health_check_interval_seconds: 3600 }]),
  );

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(healthService.probed, []);
});

test("tick() probes an adapter whose interval has elapsed", async () => {
  const healthService = fakeHealthService();
  const longAgo = new Date(Date.now() - 120_000); // 2 minutes ago
  const scheduler = new AdapterHealthSchedulerService(
    healthService,
    fakeConfigRepository([{ adapter_type: "crewai", last_health_check_at: longAgo, health_check_interval_seconds: 60 }]),
  );

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.deepEqual(healthService.probed, ["crewai"]);
});

test("tick() probes multiple due adapters independently, skipping only the not-yet-due ones", async () => {
  const healthService = fakeHealthService();
  const scheduler = new AdapterHealthSchedulerService(healthService, fakeConfigRepository([
    { adapter_type: "langchain", last_health_check_at: null, health_check_interval_seconds: 60 },
    { adapter_type: "generic_rest", last_health_check_at: new Date(), health_check_interval_seconds: 3600 },
    { adapter_type: "autogen", last_health_check_at: new Date(Date.now() - 120_000), health_check_interval_seconds: 60 },
  ]));

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.deepEqual(new Set(healthService.probed), new Set(["langchain", "autogen"]));
});
