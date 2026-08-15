import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

const SNAPSHOT_TTL_SECONDS = 60;

function cacheKey(tenantId: string): string {
  return `dashboard:health-snapshot:${tenantId}`;
}

/**
 * Last-known-good fleet-health snapshot per tenant — served as a
 * fallback when a live TimescaleDB-substitute query times out or errors,
 * per this WO's own acceptance criteria. 60s TTL: stale enough data is
 * worse than an honest "unavailable," matching the dashboard's own
 * 30-second freshness target with margin.
 */
@Injectable()
export class HealthCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async set(tenantId: string, snapshot: unknown): Promise<void> {
    await this.client.set(cacheKey(tenantId), JSON.stringify(snapshot), "EX", SNAPSHOT_TTL_SECONDS).catch(() => undefined);
  }

  async get(tenantId: string): Promise<unknown | null> {
    const raw = await this.client.get(cacheKey(tenantId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
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
