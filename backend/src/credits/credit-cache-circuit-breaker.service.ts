import { Injectable, Logger } from "@nestjs/common";
import { CreditCacheService, type CheckAndDecrementResult } from "./credit-cache.service";

type CircuitState = "closed" | "open" | "half_open";

const FAILURE_THRESHOLD = 3; // AC: "3-failure threshold"
const RESET_MS = 5000; // AC: "5s timeout" — how long the circuit stays OPEN before probing Redis again

export type GuardedCheckResult = CheckAndDecrementResult | { outcome: "circuit_open" };

/**
 * Same closed/open/half_open state machine and "never fail open"
 * posture as CircuitBreakerRateLimiterService (gateway module) — when
 * Redis is failing, MeteringEngineService must NEVER treat that as "the
 * team has unlimited credits" (that would be a real security/financial
 * hole); it falls through to the authoritative Postgres ledger check
 * instead, which is slower but always correct. `circuit_open` is a
 * distinct outcome from a genuine Redis error so callers don't have to
 * inspect exception types to tell the two apart.
 */
@Injectable()
export class CreditCacheCircuitBreakerService {
  private readonly logger = new Logger(CreditCacheCircuitBreakerService.name);
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(private readonly cache: CreditCacheService) {}

  getState(): CircuitState {
    return this.state;
  }

  async checkAndDecrement(tenantId: string, teamId: string | null, cost: number): Promise<GuardedCheckResult> {
    if (!this.shouldAttemptRedis()) return { outcome: "circuit_open" };

    try {
      const result = await this.cache.checkAndDecrement(tenantId, teamId, cost);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      return { outcome: "circuit_open" };
    }
  }

  async getBalance(tenantId: string, teamId: string | null): Promise<number | null | "circuit_open"> {
    if (!this.shouldAttemptRedis()) return "circuit_open";

    try {
      const result = await this.cache.getBalance(tenantId, teamId);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      return "circuit_open";
    }
  }

  /** Best-effort, never on the hot path — a warm-cache failure just means the next real check falls through to the ledger, no circuit-breaker bookkeeping needed. */
  async warmCache(tenantId: string, teamId: string | null, balance: number): Promise<void> {
    await this.cache.warmCache(tenantId, teamId, balance).catch((err) => this.logger.warn(`cache warm failed for ${tenantId}/${teamId}: ${err instanceof Error ? err.message : err}`));
  }

  private shouldAttemptRedis(): boolean {
    if (this.state === "open" && Date.now() - this.openedAt >= RESET_MS) {
      this.state = "half_open";
    }
    return this.state !== "open";
  }

  private onSuccess(): void {
    if (this.state !== "closed") {
      this.logger.log(`credit cache circuit recovered — closing (was ${this.state})`);
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  private onFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open" || this.consecutiveFailures >= FAILURE_THRESHOLD) {
      if (this.state !== "open") {
        this.logger.warn(`credit cache circuit OPENING after ${this.consecutiveFailures} consecutive failures — falling through to the Postgres ledger for every check until it resets: ${err instanceof Error ? err.message : err}`);
      }
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
