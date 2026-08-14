import { test } from "node:test";
import assert from "node:assert/strict";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";

// WO-016 implementation step: "performance micro-benchmark classifying
// 10,000 events and asserting P99 latency under 5ms." This measures the
// rule engine's evaluate() call in isolation (no I/O — it's a pure
// in-memory function), which is the actual hot path a pipeline stage
// would call per-event.
test("classifies 10,000 events with P99 latency under 5ms", () => {
  const engine = new ClassificationRuleEngine();
  const resourceTypes = ["health_record", "credit_transaction", "agent", "system_status", "something_unclassified"];
  const N = 10_000;
  const latenciesMs: number[] = new Array(N);

  for (let i = 0; i < N; i++) {
    const payload = { resourceType: resourceTypes[i % resourceTypes.length], fields: { iteration: i } };
    const t0 = process.hrtime.bigint();
    engine.evaluate(payload);
    const t1 = process.hrtime.bigint();
    latenciesMs[i] = Number(t1 - t0) / 1_000_000;
  }

  latenciesMs.sort((a, b) => a - b);
  const p50 = latenciesMs[Math.floor(N * 0.5)];
  const p99 = latenciesMs[Math.floor(N * 0.99)];

  // eslint-disable-next-line no-console
  console.log(`classification perf: P50=${p50.toFixed(4)}ms P99=${p99.toFixed(4)}ms over ${N} events`);
  assert.ok(p99 < 5, `P99 latency ${p99.toFixed(4)}ms must be under 5ms`);
});
