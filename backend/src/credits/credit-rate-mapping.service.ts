import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { Pool, PoolClient } from "pg";
import { CreditRateMappingRepository } from "./credit-rate-mapping.repository";
import type { TeamCreditLimit } from "./credit-rate-mapping.types";

const RATE_CACHE_TTL_SECONDS = 5 * 60; // AC: "cached in Redis with 5-minute TTL"

function rateKey(tenantId: string, actionType: string): string {
  return `credit_rate:${tenantId}:${actionType}`;
}

/** AC: action-to-credit rate lookup, Redis-cached (5min TTL), falling back to the database on a cache miss/Redis failure. */
@Injectable()
export class CreditRateMappingService implements OnModuleDestroy {
  private readonly logger = new Logger(CreditRateMappingService.name);
  private readonly redis: Redis;

  constructor(private readonly repository: CreditRateMappingRepository) {
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.redis.on("error", () => undefined);
  }

  /** Returns the effective credits-per-unit rate for this action, or null if none is configured at all — the caller (MeteringEngineService) decides what a missing rate means (this WO treats it as "deny: not configured", never a silent free action). */
  async getRate(client: Pool | PoolClient | undefined, tenantId: string, actionType: string): Promise<number | null> {
    const key = rateKey(tenantId, actionType);
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) return Number(cached);
    } catch (err) {
      this.logger.warn(`rate cache lookup failed for ${tenantId}/${actionType}, falling back to Postgres: ${err instanceof Error ? err.message : err}`);
    }

    const rate = await this.repository.findEffectiveRate(client, tenantId, actionType);
    if (rate === null) return null;

    await this.redis.set(key, rate.creditsPerUnit.toString(), "EX", RATE_CACHE_TTL_SECONDS).catch(() => undefined);
    return rate.creditsPerUnit;
  }

  async setRate(client: Pool | PoolClient | undefined, tenantId: string, actionType: string, creditsPerUnit: number): Promise<void> {
    await this.repository.upsertRate(client, tenantId, actionType, creditsPerUnit);
    await this.redis.del(rateKey(tenantId, actionType)).catch(() => undefined);
  }

  async getHardCap(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<number | null> {
    const limit = await this.repository.findHardCap(client, tenantId, teamId);
    return limit?.hardCap ?? null;
  }

  async setHardCap(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, hardCap: number | null): Promise<TeamCreditLimit> {
    return this.repository.upsertHardCap(client, tenantId, teamId, hardCap);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
