import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { RateLimitCheckResult, RateLimiterPort } from "./rate-limiter.port";

// Sliding-window-log via a sorted set: score = request timestamp (ms),
// member = a unique id per request. Atomic via a single Lua script —
// otherwise ZREMRANGEBYSCORE / ZCARD / ZADD as three separate round
// trips would race under concurrent requests for the same key (two
// requests could both read count < limit before either writes).
const SLIDING_WINDOW_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[2])
  local count = redis.call('ZCARD', KEYS[1])
  if count < tonumber(ARGV[3]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[2] * 2)
    return {1, tonumber(ARGV[3]) - count - 1}
  else
    return {0, 0}
  end
`;

@Injectable()
export class RedisRateLimiterService implements RateLimiterPort, OnModuleDestroy {
  private readonly client: Redis;
  private readyPromise: Promise<void> | null = null;

  constructor() {
    // maxRetriesPerRequest: 1 (not ioredis's default unlimited-ish
    // retry) — CircuitBreakerRateLimiterService needs a fast, bounded
    // failure signal to trip its breaker, not a client silently retrying
    // for seconds while the request path hangs.
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.client = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });

    // ioredis's 'error' event has no default handler — an unhandled one
    // crashes the process (Node's EventEmitter behavior). Real handling
    // happens per-call (checkAndConsume/waitUntilReady reject, which the
    // circuit breaker already treats as a failure); this listener exists
    // purely so a connection drop between calls doesn't take the process down.
    this.client.on("error", () => undefined);
  }

  async checkAndConsume(key: string, limit: number, windowSeconds: number): Promise<RateLimitCheckResult> {
    await this.waitUntilReady();

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const member = `${now}-${Math.random().toString(36).slice(2)}`;

    const [allowedFlag, remaining] = (await this.client.eval(SLIDING_WINDOW_SCRIPT, 1, key, now, windowMs, limit, member)) as [number, number];

    return { allowed: allowedFlag === 1, limit, remaining, resetAt: new Date(now + windowMs) };
  }

  /**
   * With `enableOfflineQueue: false`, a command issued before the
   * initial connection handshake finishes fails immediately with
   * "Stream isn't writeable" — found via testing, since every test
   * constructs a fresh client and calls checkAndConsume right away, with
   * no guarantee the handshake has completed yet (a real single
   * long-lived instance wouldn't normally hit this, but a genuinely slow
   * initial connection shouldn't be indistinguishable from "Redis is
   * down" either). Waits briefly for 'ready'; a real outage still fails
   * within this bound, which is what actually trips the circuit breaker.
   *
   * Cached as a single shared promise: N concurrent callers arriving
   * before the connection is ready must share ONE pair of 'ready'/'error'
   * listeners, not attach N of them (found via testing — 20 concurrent
   * requests during connection setup tripped ioredis's default
   * max-listeners warning).
   */
  private waitUntilReady(): Promise<void> {
    if (this.client.status === "ready") return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.client.off("ready", onReady);
        this.client.off("error", onError);
        this.readyPromise = null;
        reject(new Error("Redis connection not ready within 500ms"));
      }, 500);

      const onReady = () => {
        clearTimeout(timeout);
        this.client.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        clearTimeout(timeout);
        this.client.off("ready", onReady);
        this.readyPromise = null;
        reject(err);
      };

      this.client.once("ready", onReady);
      this.client.once("error", onError);
    });

    return this.readyPromise;
  }

  async onModuleDestroy(): Promise<void> {
    // .quit() throws if the underlying stream never finished connecting
    // (e.g. app shutdown races the initial handshake, or Redis was never
    // reachable at all) — found via testing (verify-boot.js). Shutdown
    // must never fail just because Redis wasn't in a fully-ready state.
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
