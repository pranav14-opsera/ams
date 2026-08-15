import { test } from "node:test";
import assert from "node:assert/strict";
import { TelemetrySchemaValidatorService } from "../../src/adapters/telemetry-schema-validator.service";
import { buildTenantAgentPool, generateBatch, generateSyntheticEvent } from "./synthetic-event-generator";

const CONFIG = {
  eventsPerSecond: 12,
  durationSeconds: 1,
  numTenants: 2,
  numAgentsPerTenant: 2,
  frameworkDistribution: { langchain: 0.5, genericRest: 0.5 },
  errorRate: 0.1,
};

test("WO-044: every generated synthetic event passes the real canonical telemetry schema validator", () => {
  const validator = new TelemetrySchemaValidatorService();
  const pool = buildTenantAgentPool(CONFIG).flat();
  const events = generateBatch(pool, CONFIG, 200);

  for (const event of events) {
    const result = validator.validate(event);
    assert.equal(result.valid, true, JSON.stringify({ event, errors: result.errors }));
  }
});

test("WO-044: generated events are distributed across the configured tenant/agent pool, not a single agent", () => {
  const pool = buildTenantAgentPool(CONFIG).flat();
  const events = generateBatch(pool, CONFIG, 500);
  const distinctAgents = new Set(events.map((e) => e.agent_id));
  assert.ok(distinctAgents.size > 1, "500 events across 4 agents must not all land on one agent");
  assert.ok(distinctAgents.size <= pool.length);
});

test("WO-044: framework distribution roughly matches the configured split over a large sample", () => {
  const pool = buildTenantAgentPool(CONFIG).flat();
  const events = generateBatch(pool, CONFIG, 2000);
  const langchainCount = events.filter((e) => e.framework_type === "langchain").length;
  const ratio = langchainCount / events.length;
  assert.ok(Math.abs(ratio - CONFIG.frameworkDistribution.langchain) < 0.1, `expected ~50% langchain, got ${(ratio * 100).toFixed(1)}%`);
});

test("WO-044: errorRate roughly matches the configured rate over a large sample", () => {
  const highErrorConfig = { ...CONFIG, errorRate: 0.3 };
  const pool = buildTenantAgentPool(highErrorConfig).flat();
  const events = generateBatch(pool, highErrorConfig, 3000);
  const errorCount = events.filter((e) => e.error_rate === 1).length;
  const ratio = errorCount / events.length;
  assert.ok(Math.abs(ratio - 0.3) < 0.05, `expected ~30% error rate, got ${(ratio * 100).toFixed(1)}%`);
});

test("WO-044: every event carries a generatedAtMs timestamp for end-to-end latency measurement", () => {
  const pool = buildTenantAgentPool(CONFIG).flat();
  const before = Date.now();
  const event = generateSyntheticEvent(pool, CONFIG);
  const after = Date.now();
  const generatedAtMs = (event.metadata as any).generatedAtMs;
  assert.ok(typeof generatedAtMs === "number" && generatedAtMs >= before && generatedAtMs <= after);
});
