import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MetricsAggregatorService } from "../../../src/adapters/metrics/metrics-aggregator.service";
import type { CanonicalTelemetryEvent } from "../../../src/adapters/schemas/canonical-telemetry";

function fakeRepository() {
  const calls: Array<{ tenantId: string; agentId: string; metricName: string; value: number }> = [];
  return {
    calls,
    recordMetric: async (tenantId: string, agentId: string, metricName: string, value: number) => {
      calls.push({ tenantId, agentId, metricName, value });
    },
  } as any;
}

function fakeEvent(overrides: Partial<CanonicalTelemetryEvent> = {}): CanonicalTelemetryEvent {
  return {
    event_id: randomUUID(),
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: "metric" as any,
    latency_ms: 120,
    error_rate: 0,
    token_consumption: 10,
    tool_call_success: null,
    tool_call_name: null,
    framework_type: "generic_rest",
    adapter_version: "1.0.0",
    raw_payload_hash: "a".repeat(64),
    metadata: {},
    ...overrides,
  };
}

test("records both latency_ms and error_rate when both are present", async () => {
  const repository = fakeRepository();
  const service = new MetricsAggregatorService(repository);
  const event = fakeEvent({ latency_ms: 88, error_rate: 0.1 });

  await service.recordCanonicalEvent(undefined, event);

  assert.equal(repository.calls.length, 2);
  assert.deepEqual(
    repository.calls.map((c: any) => c.metricName).sort(),
    ["error_rate", "latency_ms"],
  );
  const latencyCall = repository.calls.find((c: any) => c.metricName === "latency_ms")!;
  assert.equal(latencyCall.value, 88);
  assert.equal(latencyCall.tenantId, event.tenant_id);
  assert.equal(latencyCall.agentId, event.agent_id);
});

test("skips latency_ms when null (e.g. a _start trace event)", async () => {
  const repository = fakeRepository();
  const service = new MetricsAggregatorService(repository);
  await service.recordCanonicalEvent(undefined, fakeEvent({ latency_ms: null, error_rate: null }));
  assert.equal(repository.calls.length, 0);
});

test("records error_rate: 0 (a valid, meaningful success signal, not treated as absent)", async () => {
  const repository = fakeRepository();
  const service = new MetricsAggregatorService(repository);
  await service.recordCanonicalEvent(undefined, fakeEvent({ latency_ms: null, error_rate: 0 }));
  assert.equal(repository.calls.length, 1);
  assert.equal(repository.calls[0].metricName, "error_rate");
  assert.equal(repository.calls[0].value, 0);
});

test("a repository failure is swallowed (best-effort) and never propagates to the caller", async () => {
  const repository = { recordMetric: async () => { throw new Error("db down"); } } as any;
  const service = new MetricsAggregatorService(repository);
  await service.recordCanonicalEvent(undefined, fakeEvent());
  // No throw = pass. Telemetry ingestion must never fail because metrics recording failed.
});
