import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSegmentStats, LatencyCollector } from "./latency-stats";

test("WO-044: computeSegmentStats against a known uniform distribution 1..100", () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1);
  const stats = computeSegmentStats(samples);

  assert.equal(stats.count, 100);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 100);
  assert.equal(stats.p50, 50);
  assert.equal(stats.p95, 95);
  assert.equal(stats.p99, 99);
  assert.equal(stats.mean, 50.5);
});

test("WO-044: computeSegmentStats on an empty sample set returns zeros rather than throwing/NaN", () => {
  const stats = computeSegmentStats([]);
  assert.deepEqual(stats, { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 });
});

test("WO-044: computeSegmentStats on a single sample returns that value for every percentile", () => {
  const stats = computeSegmentStats([42]);
  assert.equal(stats.p50, 42);
  assert.equal(stats.p95, 42);
  assert.equal(stats.p99, 42);
  assert.equal(stats.mean, 42);
});

test("WO-044: a tail of outliers beyond the 99th percentile threshold shows up in p99 but not p50", () => {
  // 95 typical values + 5 outliers (the top 5% of 100 samples) — with the
  // nearest-rank method, p99's rank (ceil(0.99*100)=99th value, 1-indexed)
  // falls inside that outlier tail, while p50 does not.
  const samples = [...Array.from({ length: 95 }, () => 10), ...Array.from({ length: 5 }, () => 5000)];
  const stats = computeSegmentStats(samples);
  assert.equal(stats.p50, 10);
  assert.equal(stats.p99, 5000);
});

test("WO-044: LatencyCollector groups samples by stage independently", () => {
  const collector = new LatencyCollector();
  collector.record("stage_a", 10);
  collector.record("stage_a", 20);
  collector.record("stage_b", 100);

  const stats = collector.stats();
  assert.equal(stats.stage_a.count, 2);
  assert.equal(stats.stage_b.count, 1);
  assert.deepEqual(collector.stages().sort(), ["stage_a", "stage_b"]);
});
