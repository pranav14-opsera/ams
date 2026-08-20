import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

const SNAPSHOT_TTL_SECONDS = 60; // matches HealthCacheService's own reasoning: stale data past this is worse than an honest "unavailable", with margin over the 30s freshness AC.
const BALANCE_TTL_SECONDS = 30; // AC: "real-time balance from Redis cache with PostgreSQL fallthrough" — same 30s TTL as CreditCacheService's own balance cache.

function snapshotKey(tenantId: string): string {
  return `dashboard:org-usage-snapshot:${tenantId}`;
}

function balanceKey(tenantId: string): string {
  return `dashboard:org-usage-balance:${tenantId}`;
}

/**
 * Last-known-good org usage snapshot + a short-TTL balance cache, per
 * tenant — served as the fallback when a live query times out/errors
 * (error_handling AC: "API timeout (>5s): Return cached last-known-good
 * data with stale indicator") or as the fast path for the balance
 * endpoint (technical_details AC: "real-time balance from Redis cache
 * with PostgreSQL fallthrough").
 */
@Injectable()
export class OrgUsageCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async setSnapshot(tenantId: string, snapshot: unknown): Promise<void> {
    await this.client.set(snapshotKey(tenantId), JSON.stringify(snapshot), "EX", SNAPSHOT_TTL_SECONDS).catch(() => undefined);
  }

  async getSnapshot(tenantId: string): Promise<unknown | null> {
    const raw = await this.client.get(snapshotKey(tenantId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async setBalance(tenantId: string, balance: unknown): Promise<void> {
    await this.client.set(balanceKey(tenantId), JSON.stringify(balance), "EX", BALANCE_TTL_SECONDS).catch(() => undefined);
  }

  async getBalance(tenantId: string): Promise<unknown | null> {
    const raw = await this.client.get(balanceKey(tenantId)).catch(() => null);
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
