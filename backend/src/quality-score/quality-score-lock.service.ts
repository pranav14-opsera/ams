import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";

const LOCK_KEY = "quality-score:scheduler-lock";
/** AC: 4-minute TTL — comfortably under the 5-minute tick interval, so a crashed holder never blocks the next tick for longer than one cycle. */
const LOCK_TTL_SECONDS = 4 * 60;

/**
 * A simple Redis SETNX-with-TTL distributed lock so that running
 * multiple instances of this service (the normal production topology)
 * doesn't compute and store the same agent's quality score multiple
 * times per tick. First lock of this shape in this codebase — no
 * existing scheduler in this repo needed one (WO-059/060/061/062's
 * schedulers are all naturally idempotent per-tenant reads/writes with
 * cooldowns, whereas this scheduler's own writes — a new
 * quality_score_history row every tick — are NOT idempotent; a second
 * concurrent run would insert a duplicate row).
 */
@Injectable()
export class QualityScoreLockService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  /** Returns a release function if the lock was acquired, or null if another instance already holds it. */
  async acquire(): Promise<(() => Promise<void>) | null> {
    const token = randomUUID();
    const acquired = await this.client.set(LOCK_KEY, token, "EX", LOCK_TTL_SECONDS, "NX").catch(() => null);
    if (acquired !== "OK") return null;

    return async () => {
      // Only release if we still hold it (token match) — a lock that outlived its own holder (e.g. a slow tick past the TTL) may already have been reacquired by another instance; releasing unconditionally could delete THEIR lock.
      const current = await this.client.get(LOCK_KEY).catch(() => null);
      if (current === token) await this.client.del(LOCK_KEY).catch(() => undefined);
    };
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
