import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

const SNAPSHOT_TTL_SECONDS = 60; // same reasoning as OrgUsageCacheService's own SNAPSHOT_TTL_SECONDS.

// Cache key includes a hash of the applied filters — different filter
// combinations for the same team are genuinely different query results,
// so caching them under one shared key would serve stale/wrong data back
// for whichever filter combo didn't happen to run last (edge_cases: filter
// changes must reflect within 2s via a fresh fetch, never a stale cached
// snapshot for a DIFFERENT filter set).
function snapshotKey(tenantId: string, teamId: string, filterHash: string): string {
  return `dashboard:team-usage-snapshot:${tenantId}:${teamId}:${filterHash}`;
}

/** Last-known-good team usage snapshot, per tenant+team+filter-combination — same fallback-on-live-query-failure posture as OrgUsageCacheService. */
@Injectable()
export class TeamUsageCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async setSnapshot(tenantId: string, teamId: string, filterHash: string, snapshot: unknown): Promise<void> {
    await this.client.set(snapshotKey(tenantId, teamId, filterHash), JSON.stringify(snapshot), "EX", SNAPSHOT_TTL_SECONDS).catch(() => undefined);
  }

  async getSnapshot(tenantId: string, teamId: string, filterHash: string): Promise<unknown | null> {
    const raw = await this.client.get(snapshotKey(tenantId, teamId, filterHash)).catch(() => null);
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
