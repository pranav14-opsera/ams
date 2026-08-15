import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { SubscriptionRegistryService } from "./subscription-registry.service";

export interface HeartbeatManagerOptions {
  /** How often the sweep runs and pings are sent. Default 5s per this WO's acceptance criteria. */
  sweepIntervalMs?: number;
  /** A connection with no pong within this window of its last heartbeat is stale. Default 35s (30s ping cadence + 5s grace). */
  staleThresholdMs?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_STALE_THRESHOLD_MS = 35_000;

/**
 * Registry-level staleness sweep — distinct from (and complementary to)
 * BaseRealtimeGateway's existing per-socket ping/pong timer
 * (base-realtime.gateway.ts): that timer detects one connection going
 * dark; this sweep periodically walks the WHOLE registry so a
 * SubscriptionManager built on top of it (rather than a single gateway's
 * own client map) has one place that terminates every connection that
 * hasn't proven liveness recently, regardless of which channel(s) it's
 * subscribed to.
 */
@Injectable()
export class HeartbeatManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatManagerService.name);
  private sweepHandle: NodeJS.Timeout | null = null;
  private readonly sweepIntervalMs: number;
  private readonly staleThresholdMs: number;

  constructor(
    private readonly registry: SubscriptionRegistryService,
    private readonly pingAll: (userId: string, tenantId: string) => void,
    private readonly terminate: (userId: string, tenantId: string) => void,
    options: HeartbeatManagerOptions = {},
  ) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  }

  start(): void {
    if (this.sweepHandle) return;
    this.sweepHandle = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepHandle.unref?.();
  }

  stop(): void {
    if (!this.sweepHandle) return;
    clearInterval(this.sweepHandle);
    this.sweepHandle = null;
  }

  /** Called when a pong (or any liveness signal) arrives for a session. */
  recordPong(session: { userId: string; tenantId: string; lastHeartbeat: number }, now: number = Date.now()): void {
    session.lastHeartbeat = now;
  }

  sweep(now: number = Date.now()): { pinged: number; terminated: number } {
    let pinged = 0;
    let terminated = 0;

    for (const session of this.registry.getAllSessions()) {
      const silentFor = now - session.lastHeartbeat;
      if (silentFor > this.staleThresholdMs) {
        this.logger.warn(`heartbeat timeout — terminating stale connection user=${session.userId} tenant=${session.tenantId}`);
        this.terminate(session.userId, session.tenantId);
        terminated++;
      } else {
        this.pingAll(session.userId, session.tenantId);
        pinged++;
      }
    }

    return { pinged, terminated };
  }

  onModuleDestroy(): void {
    this.stop();
  }
}
