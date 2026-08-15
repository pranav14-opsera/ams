import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

const CACHE_TTL_SECONDS = 3600; // well above the 1hr evaluation cadence; Postgres (DriftStateRepository) remains the durable copy restored on a cache miss

interface CachedState {
  consecutiveDriftCount: number;
  lastKsStatistic: number;
  lastPValue: number;
}

function key(tenantId: string, agentId: string): string {
  return `drift_state:${tenantId}:${agentId}`;
}

/** AC: "consecutive window tracking in Redis ... with PostgreSQL fallback for state recovery" — same hot-cache/durable-copy split as WO-061's EwmaStateCacheService. */
@Injectable()
export class DriftStateCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async get(tenantId: string, agentId: string): Promise<CachedState | null> {
    const raw = await this.client.get(key(tenantId, agentId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedState;
    } catch {
      return null;
    }
  }

  async set(tenantId: string, agentId: string, state: CachedState): Promise<void> {
    await this.client.set(key(tenantId, agentId), JSON.stringify(state), "EX", CACHE_TTL_SECONDS).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
