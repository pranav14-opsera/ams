import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { AlertMetricName } from "./alert-threshold.types";

const SNAPSHOT_TTL_SECONDS = 120; // well above the 5s evaluation cadence — a stale/dead agent's snapshot naturally expires rather than being evaluated forever against last-known values

function snapshotKey(tenantId: string, agentId: string): string {
  return `alerts:metric-snapshot:${tenantId}:${agentId}`;
}

export type MetricSnapshot = Partial<Record<AlertMetricName, number>>;

/**
 * The "cached metric snapshot" ThresholdEvaluatorService reads from
 * (this WO's own AC/architecture) — a per-agent Redis hash refreshed
 * every evaluation tick from the same health-aggregate data
 * DashboardService already reads (WO-056/057), rather than re-querying
 * Postgres inline in the hot evaluation loop.
 */
@Injectable()
export class MetricSnapshotCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async setSnapshot(tenantId: string, agentId: string, snapshot: MetricSnapshot): Promise<void> {
    const entries = Object.entries(snapshot).filter(([, value]) => value !== null && value !== undefined);
    if (entries.length === 0) return;

    const pipeline = this.client.pipeline();
    pipeline.hset(snapshotKey(tenantId, agentId), Object.fromEntries(entries.map(([k, v]) => [k, String(v)])));
    pipeline.expire(snapshotKey(tenantId, agentId), SNAPSHOT_TTL_SECONDS);
    await pipeline.exec().catch(() => undefined);
  }

  /** AC/implementation step: "Redis pipeline to batch-read metric snapshots for all active agents in a tenant." */
  async getSnapshots(tenantId: string, agentIds: string[]): Promise<Map<string, MetricSnapshot>> {
    if (agentIds.length === 0) return new Map();

    const pipeline = this.client.pipeline();
    for (const agentId of agentIds) pipeline.hgetall(snapshotKey(tenantId, agentId));

    const results = await pipeline.exec().catch(() => null);
    const snapshots = new Map<string, MetricSnapshot>();
    if (!results) return snapshots;

    agentIds.forEach((agentId, index) => {
      const [err, raw] = results[index] ?? [null, {}];
      if (err || !raw) return;
      const parsed: MetricSnapshot = {};
      for (const [key, value] of Object.entries(raw as Record<string, string>)) {
        parsed[key as AlertMetricName] = Number(value);
      }
      if (Object.keys(parsed).length > 0) snapshots.set(agentId, parsed);
    });

    return snapshots;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
