import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { EmailChannelConfig } from "./channels/email-alert-channel.service";
import type { WebhookChannelConfig } from "./channels/webhook-alert-channel.service";

const CACHE_TTL_SECONDS = 60;

export interface ResolvedChannelConfigs {
  webhooks: WebhookChannelConfig[];
  emails: EmailChannelConfig[];
}

function cacheKey(tenantId: string): string {
  return `alerts:channel-config:${tenantId}`;
}

/**
 * AC: tenant channel configurations "cached in Redis with 60s TTL" —
 * resolving a webhook config requires a KMS decrypt call per secret;
 * caching the RESOLVED (already-decrypted) shape avoids repeating that
 * on every single delivery.
 *
 * Security tradeoff, stated explicitly rather than silently accepted:
 * this means the plaintext HMAC secret sits in Redis for up to 60
 * seconds. Acceptable given this platform's threat model (Redis is a
 * private, same-VPC service with no external network exposure, same
 * trust boundary every other Redis-cached value in this codebase
 * already sits inside — e.g. ConnectionRegistryService's connection
 * counts, HealthCacheService's fleet snapshots) — but a stricter
 * deployment could instead cache only the ciphertext and decrypt on
 * every read, trading the KMS call cost back in for zero plaintext
 * secret residency in Redis.
 */
@Injectable()
export class ChannelConfigCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async get(tenantId: string): Promise<ResolvedChannelConfigs | null> {
    const raw = await this.client.get(cacheKey(tenantId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ResolvedChannelConfigs;
    } catch {
      return null;
    }
  }

  async set(tenantId: string, configs: ResolvedChannelConfigs): Promise<void> {
    await this.client.set(cacheKey(tenantId), JSON.stringify(configs), "EX", CACHE_TTL_SECONDS).catch(() => undefined);
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.client.del(cacheKey(tenantId)).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
