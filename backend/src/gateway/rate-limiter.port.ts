export const RATE_LIMITER = "RATE_LIMITER";

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Approximate — a sliding-window-log has no single fixed reset instant; this is `now + windowSeconds`, the same approximation widely-used rate-limited APIs report. */
  resetAt: Date;
}

export interface RateLimiterPort {
  /** Atomically checks whether `key` has capacity within `limit` per `windowSeconds`, and consumes one unit of capacity if so. */
  checkAndConsume(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheckResult>;
}
