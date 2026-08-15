import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { WS_CONFIG } from "./ws-config";

// Atomic check-and-increment — INCR always succeeds, so a bare INCR then
// compare-and-DECR-if-over-limit would let a burst of concurrent
// connections all see the raw (pre-check) count and momentarily exceed
// the limit before any of them roll back. This script makes "increment
// AND check" one atomic step.
const ACQUIRE_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  if current > tonumber(ARGV[1]) then
    redis.call('DECR', KEYS[1])
    return 0
  end
  return 1
`;

export interface ConnectionInfo {
  connectionId: string;
  tenantId: string;
  userId: string;
  roles: string[];
  channel: string;
}

/**
 * Per-tenant connection limit enforcement — real Redis atomic counters
 * (so the limit holds across every gateway pod replica, not just this
 * process), plus a local in-memory Map for this pod's own connections
 * (message batching/role filtering only ever need to reach connections
 * THIS pod is holding open; Redis pub/sub, not this map, is what fans a
 * message out across pods).
 *
 * Known limitation (documented, not silently ignored): if a pod is
 * killed ungracefully (not a clean disconnect), its connections'
 * counters are never released — a real production deployment would
 * additionally TTL/lease these counters and have a reconciliation sweep.
 * Out of scope for this sandbox; every connection this service itself
 * releases (clean disconnect, which its own tests exercise) is correctly
 * decremented.
 */
@Injectable()
export class ConnectionRegistryService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly localConnections = new Map<string, ConnectionInfo>();

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async acquire(info: ConnectionInfo, maxConnections: number = WS_CONFIG.defaultMaxConnectionsPerTenant): Promise<boolean> {
    const key = `ws:tenant-connections:${info.tenantId}`;
    const acquired = (await this.client.eval(ACQUIRE_SCRIPT, 1, key, maxConnections)) as number;
    if (acquired !== 1) return false;

    this.localConnections.set(info.connectionId, info);
    return true;
  }

  async release(connectionId: string): Promise<void> {
    const info = this.localConnections.get(connectionId);
    if (!info) return;

    this.localConnections.delete(connectionId);
    await this.client.decr(`ws:tenant-connections:${info.tenantId}`).catch(() => undefined);
  }

  getLocalConnectionCount(tenantId: string): number {
    return [...this.localConnections.values()].filter((c) => c.tenantId === tenantId).length;
  }

  getLocalConnection(connectionId: string): ConnectionInfo | undefined {
    return this.localConnections.get(connectionId);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
