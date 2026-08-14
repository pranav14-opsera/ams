import { Inject, Injectable, Logger } from "@nestjs/common";
import { RATE_LIMIT_CONFIG } from "./rate-limit.config";
import { RateLimitMetricsService } from "./rate-limit-metrics.service";
import type { RateLimitCheckResult, RateLimiterPort } from "./rate-limiter.port";
import { InMemoryRateLimiterService } from "./in-memory-rate-limiter.service";
import { RedisRateLimiterService } from "./redis-rate-limiter.service";

type CircuitState = "closed" | "open" | "half_open";

/**
 * Wraps the Redis-backed limiter with a 3-failure-threshold circuit
 * breaker: CLOSED (normal — every check goes to Redis) -> OPEN (Redis
 * is failing; every check goes to the in-memory fallback at a
 * conservative fraction of the configured limit, per this WO's
 * "never fail open" requirement — OWASP A10) -> after
 * circuitBreakerResetMs, HALF_OPEN (the next check probes Redis once;
 * success closes the circuit, failure re-opens it).
 */
@Injectable()
export class CircuitBreakerRateLimiterService implements RateLimiterPort {
  private readonly logger = new Logger(CircuitBreakerRateLimiterService.name);
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    @Inject(RedisRateLimiterService) private readonly redis: RateLimiterPort,
    private readonly fallback: InMemoryRateLimiterService,
    private readonly metrics: RateLimitMetricsService,
  ) {}

  getState(): CircuitState {
    return this.state;
  }

  async checkAndConsume(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheckResult> {
    if (this.state === "open" && Date.now() - this.openedAt >= RATE_LIMIT_CONFIG.circuitBreakerResetMs) {
      this.state = "half_open";
      this.metrics.recordCircuitBreakerState(this.state);
    }

    if (this.state === "open") {
      return this.useFallback(key, limit, windowSeconds);
    }

    try {
      const result = await this.redis.checkAndConsume(key, limit, windowSeconds);
      this.onRedisSuccess();
      return result;
    } catch (err) {
      this.onRedisFailure(err);
      return this.useFallback(key, limit, windowSeconds);
    }
  }

  private useFallback(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheckResult> {
    const fallbackLimit = Math.max(1, Math.floor(limit * RATE_LIMIT_CONFIG.fallbackLimitFactor));
    return this.fallback.checkAndConsume(key, fallbackLimit, windowSeconds);
  }

  private onRedisSuccess(): void {
    if (this.state !== "closed") {
      this.logger.log(`Redis rate limiter recovered — circuit closing (was ${this.state})`);
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.metrics.recordCircuitBreakerState(this.state);
  }

  private onRedisFailure(err: unknown): void {
    this.metrics.recordRedisError();
    this.consecutiveFailures += 1;

    if (this.state === "half_open" || this.consecutiveFailures >= RATE_LIMIT_CONFIG.circuitBreakerFailureThreshold) {
      if (this.state !== "open") {
        this.logger.warn(
          `Redis rate limiter circuit OPENING after ${this.consecutiveFailures} consecutive failures — falling back to in-memory (never failing open): ${err instanceof Error ? err.message : err}`,
        );
      }
      this.state = "open";
      this.openedAt = Date.now();
      this.metrics.recordCircuitBreakerState(this.state);
    }
  }
}
