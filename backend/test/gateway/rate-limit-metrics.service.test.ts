import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimitMetricsService } from "../../src/gateway/rate-limit-metrics.service";

test("exposes rate_limit_hits_total labeled by scope/endpoint_group/result", async () => {
  const metrics = new RateLimitMetricsService();
  metrics.recordHit("tenant", "agents", "allowed");
  metrics.recordHit("user", "credits", "denied");

  const text = await metrics.metricsText();
  assert.ok(text.includes('rate_limit_hits_total{scope="tenant",endpoint_group="agents",result="allowed"} 1'));
  assert.ok(text.includes('rate_limit_hits_total{scope="user",endpoint_group="credits",result="denied"} 1'));
});

test("exposes rate_limit_remaining as a gauge", async () => {
  const metrics = new RateLimitMetricsService();
  metrics.recordRemaining("tenant", "tenant-1", 42);

  const text = await metrics.metricsText();
  assert.ok(text.includes('rate_limit_remaining{scope="tenant",key="tenant-1"} 42'));
});

test("exposes redis_rate_limiter_circuit_breaker_state as 0/1/2 for closed/open/half_open", async () => {
  const metrics = new RateLimitMetricsService();
  metrics.recordCircuitBreakerState("closed");
  assert.ok((await metrics.metricsText()).includes("redis_rate_limiter_circuit_breaker_state 0"));

  metrics.recordCircuitBreakerState("open");
  assert.ok((await metrics.metricsText()).includes("redis_rate_limiter_circuit_breaker_state 1"));

  metrics.recordCircuitBreakerState("half_open");
  assert.ok((await metrics.metricsText()).includes("redis_rate_limiter_circuit_breaker_state 2"));
});

test("exposes redis_rate_limiter_errors_total as a counter", async () => {
  const metrics = new RateLimitMetricsService();
  metrics.recordRedisError();
  metrics.recordRedisError();

  const text = await metrics.metricsText();
  assert.ok(text.includes("redis_rate_limiter_errors_total 2"));
});
