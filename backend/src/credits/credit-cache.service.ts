import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

const BALANCE_CACHE_TTL_SECONDS = 30; // AC: "configurable TTL (default 30 seconds)"

function balanceKey(tenantId: string, teamId: string | null): string {
  return `credit_balance:${tenantId}:${teamId ?? "__none__"}`;
}

export type CheckAndDecrementResult =
  | { outcome: "cache_miss" }
  | { outcome: "denied"; balance: number }
  | { outcome: "allowed"; balance: number };

/**
 * AC: "atomically decremented on allow decisions using DECRBY to prevent
 * race conditions between concurrent checks" — a single Lua script does
 * the read-compare-decrement as one atomic Redis operation (Lua scripts
 * run atomically on a single Redis node), so two concurrent requests for
 * the same team can never both read "balance is sufficient" and both
 * decrement past zero.
 */
const CHECK_AND_DECREMENT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then
  return {-1, 0}
end
current = tonumber(current)
local cost = tonumber(ARGV[1])
if current < cost then
  return {0, current}
end
local newBalance = redis.call('DECRBY', KEYS[1], cost)
return {1, newBalance}
`;

@Injectable()
export class CreditCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async getBalance(tenantId: string, teamId: string | null): Promise<number | null> {
    const raw = await this.client.get(balanceKey(tenantId, teamId));
    return raw === null ? null : Number(raw);
  }

  async warmCache(tenantId: string, teamId: string | null, balance: number, ttlSeconds: number = BALANCE_CACHE_TTL_SECONDS): Promise<void> {
    await this.client.set(balanceKey(tenantId, teamId), balance.toString(), "EX", ttlSeconds);
  }

  async invalidateBalance(tenantId: string, teamId: string | null): Promise<void> {
    await this.client.del(balanceKey(tenantId, teamId));
  }

  /** Atomic check-and-decrement. `cache_miss` when the key doesn't exist at all (caller should warm the cache and retry) — distinct from `denied` (key exists, insufficient balance). */
  async checkAndDecrement(tenantId: string, teamId: string | null, cost: number): Promise<CheckAndDecrementResult> {
    const [flag, balance] = (await this.client.eval(CHECK_AND_DECREMENT_SCRIPT, 1, balanceKey(tenantId, teamId), cost.toString())) as [number, number];
    if (flag === -1) return { outcome: "cache_miss" };
    if (flag === 0) return { outcome: "denied", balance };
    return { outcome: "allowed", balance };
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
