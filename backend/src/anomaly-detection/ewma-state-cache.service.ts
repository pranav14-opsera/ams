import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { EwmaState } from "../algorithms/ewma";
import type { AnomalyMetricName } from "./anomaly-detection.types";

const CACHE_TTL_SECONDS = 3600; // well above the 5s evaluation cadence; Postgres (AnomalyBaselineRepository) remains the durable copy restored on a cache miss

function key(tenantId: string, agentId: string, metricName: AnomalyMetricName): string {
  return `anomaly:ewma-state:${tenantId}:${agentId}:${metricName}`;
}

/** AC/implementation step: "AnomalyDetectorService with dependency-injected Redis (for EWMA state cache)" — the hot per-5s-tick read/write path; Postgres is the durable copy, written through on every tick too (consistency over raw throughput for a value this cheap to persist), and used to reseed Redis after a restart/cache-miss. */
@Injectable()
export class EwmaStateCacheService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    this.client.on("error", () => undefined);
  }

  async get(tenantId: string, agentId: string, metricName: AnomalyMetricName): Promise<EwmaState | null> {
    const raw = await this.client.get(key(tenantId, agentId, metricName)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EwmaState;
    } catch {
      return null;
    }
  }

  async set(tenantId: string, agentId: string, metricName: AnomalyMetricName, state: EwmaState): Promise<void> {
    await this.client.set(key(tenantId, agentId, metricName), JSON.stringify(state), "EX", CACHE_TTL_SECONDS).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
