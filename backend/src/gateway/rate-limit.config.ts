// WO-027's own defaults: per-tenant 1,000 req/s, per-user 100 req/s,
// warning header once 80% of the limit is consumed, and a conservative
// 50%-of-configured ceiling for the in-memory fallback tier that takes
// over when Redis is unavailable (never fail open — OWASP A10).
export const RATE_LIMIT_CONFIG = {
  defaultTenantLimitPerSecond: 1000,
  defaultUserLimitPerSecond: 100,
  windowSeconds: 1,
  warningThresholdRatio: 0.8,
  fallbackLimitFactor: 0.5,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerResetMs: 30_000,
} as const;

// Routes exempt from rate limiting entirely — health checks must always
// answer for Kubernetes probes regardless of platform traffic load, and
// the Prometheus scrape endpoint has no tenant/user to attribute a limit
// to in the first place.
export const RATE_LIMIT_EXEMPT_PATHS = ["health/live", "health/ready", "health/startup", "metrics"];
