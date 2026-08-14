import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Registry } from "prom-client";

export type CircuitBreakerState = "closed" | "open" | "half_open";

@Injectable()
export class RateLimitMetricsService {
  readonly registry = new Registry();

  private readonly hitsTotal = new Counter({
    name: "rate_limit_hits_total",
    help: "Rate limit checks, labeled by scope (tenant/user), endpoint group, and result (allowed/denied).",
    labelNames: ["scope", "endpoint_group", "result"],
    registers: [this.registry],
  });

  private readonly remainingGauge = new Gauge({
    name: "rate_limit_remaining",
    help: "Remaining capacity in the current window for the most recently checked key.",
    labelNames: ["scope", "key"],
    registers: [this.registry],
  });

  private readonly circuitBreakerState = new Gauge({
    name: "redis_rate_limiter_circuit_breaker_state",
    help: "Circuit breaker state: 0=closed (using Redis), 1=open (using in-memory fallback), 2=half_open (probing Redis).",
    registers: [this.registry],
  });

  private readonly errorsTotal = new Counter({
    name: "redis_rate_limiter_errors_total",
    help: "Total Redis errors encountered by the rate limiter.",
    registers: [this.registry],
  });

  recordHit(scope: "tenant" | "user", endpointGroup: string, result: "allowed" | "denied"): void {
    this.hitsTotal.inc({ scope, endpoint_group: endpointGroup, result });
  }

  recordRemaining(scope: "tenant" | "user", key: string, remaining: number): void {
    this.remainingGauge.set({ scope, key }, remaining);
  }

  recordCircuitBreakerState(state: CircuitBreakerState): void {
    this.circuitBreakerState.set(state === "closed" ? 0 : state === "open" ? 1 : 2);
  }

  recordRedisError(): void {
    this.errorsTotal.inc();
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
