import { Injectable } from "@nestjs/common";
import type { RateLimitCheckResult, RateLimiterPort } from "./rate-limiter.port";

/**
 * A real, functional sliding-window-log rate limiter (per-process
 * timestamp arrays, not a stub) — this codebase's established pattern
 * for a genuinely working single-instance implementation with a
 * documented multi-instance successor (see e.g. InMemorySessionStore,
 * InMemoryRefreshTokenStore, InMemoryMfaRateLimiter). Used two ways in
 * this module: directly, for tests and single-instance deployments; and
 * as the CircuitBreakerRateLimiter's degraded fallback tier when Redis
 * is unavailable — that second use is exactly why this must be a real
 * algorithm and not a placeholder, its correctness is load-bearing even
 * in production.
 */
@Injectable()
export class InMemoryRateLimiterService implements RateLimiterPort {
  private readonly windows = new Map<string, number[]>();

  async checkAndConsume(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheckResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const cutoff = now - windowMs;

    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= limit) {
      this.windows.set(key, timestamps);
      return { allowed: false, limit, remaining: 0, resetAt: new Date(now + windowMs) };
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return { allowed: true, limit, remaining: limit - timestamps.length, resetAt: new Date(now + windowMs) };
  }
}
