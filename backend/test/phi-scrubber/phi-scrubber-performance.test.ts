import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";

// WO-017 acceptance criteria: "adds less than 10ms latency per event in
// the ingestion path at P99" and implementation step: "scrubbing 10,000
// events at 1KB, 5KB, and 10KB sizes and assert P99 latency under 10ms."
function payloadOfSize(approxBytes: number): Record<string, unknown> {
  const filler = "x".repeat(Math.max(0, approxBytes - 200));
  return {
    patient_id: "12345",
    ssn: "123-45-6789",
    diagnosis: "hypertension",
    note: filler,
    agent_name: "intake-agent",
    amount: 42.5,
  };
}

function benchmark(sizeLabel: string, approxBytes: number, n: number): number {
  const scrubber = new PhiScrubberService();
  const payload = payloadOfSize(approxBytes);
  const latenciesMs: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    scrubber.scrub(payload);
    const t1 = process.hrtime.bigint();
    latenciesMs[i] = Number(t1 - t0) / 1_000_000;
  }

  latenciesMs.sort((a, b) => a - b);
  const p99 = latenciesMs[Math.floor(n * 0.99)];
  // eslint-disable-next-line no-console
  console.log(`phi scrubber perf (${sizeLabel}): P50=${latenciesMs[Math.floor(n * 0.5)].toFixed(4)}ms P99=${p99.toFixed(4)}ms over ${n} events`);
  return p99;
}

test("scrubbing 10,000 1KB events stays under 10ms P99", () => {
  assert.ok(benchmark("1KB", 1024, 10_000) < 10);
});

test("scrubbing 10,000 5KB events stays under 10ms P99", () => {
  assert.ok(benchmark("5KB", 5 * 1024, 10_000) < 10);
});

test("scrubbing 10,000 10KB events stays under 10ms P99", () => {
  assert.ok(benchmark("10KB", 10 * 1024, 10_000) < 10);
});
