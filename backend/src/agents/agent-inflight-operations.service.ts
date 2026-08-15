import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

function inFlightKey(agentId: string): string {
  return `agent:inflight:${agentId}`;
}

export interface DrainResult {
  drained: boolean;
  remainingCount: number;
}

/**
 * Tracks operations currently executing against a given agent (future
 * agent-execution WOs call increment()/decrement() around each run) so a
 * Paused transition can wait for them to finish rather than yanking the
 * agent out from under an in-flight request. Redis-backed (not in-process
 * memory) since the app can run multiple instances — the counter has to
 * be visible cluster-wide, same reasoning as WO-027's rate limiter and
 * WO-030's connection-limit counter.
 */
@Injectable()
export class AgentInFlightOperationsService implements OnModuleDestroy {
  private readonly client: Redis;
  private readyPromise: Promise<void> | null = null;

  constructor() {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.client = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
    // See WO-027's redis-rate-limiter.service.ts for why this listener
    // exists: an unhandled ioredis 'error' event crashes the process.
    this.client.on("error", () => undefined);
  }

  private async waitUntilReady(): Promise<void> {
    if (this.client.status === "ready") return;
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Redis connection not ready within 500ms")), 500);
        this.client.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    return this.readyPromise;
  }

  async increment(agentId: string): Promise<number> {
    await this.waitUntilReady();
    return this.client.incr(inFlightKey(agentId));
  }

  async decrement(agentId: string): Promise<number> {
    await this.waitUntilReady();
    const result = await this.client.decr(inFlightKey(agentId));
    if (result < 0) {
      // Defensive floor: an unbalanced decrement (e.g. a caller
      // decrementing twice for one increment) must never leave the
      // counter negative, which would make waitForDrain's "count === 0"
      // check impossible to satisfy on the next legitimate increment.
      await this.client.set(inFlightKey(agentId), "0");
      return 0;
    }
    return result;
  }

  async getCount(agentId: string): Promise<number> {
    await this.waitUntilReady();
    const value = await this.client.get(inFlightKey(agentId));
    return value ? Number(value) : 0;
  }

  /** Polls the in-flight counter every `pollIntervalMs` until it reaches 0 or `timeoutMs` elapses. */
  async waitForDrain(agentId: string, timeoutMs: number, pollIntervalMs = 100): Promise<DrainResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const count = await this.getCount(agentId);
      if (count === 0) return { drained: true, remainingCount: 0 };
      if (Date.now() >= deadline) return { drained: false, remainingCount: count };
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
