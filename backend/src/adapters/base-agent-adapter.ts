import type { AdapterMetadata, ConnectionValidationResult, HealthProbeResult, IAgentAdapter } from "./interfaces/agent-adapter.interface";
import type { CanonicalTelemetryEvent } from "./schemas/canonical-telemetry";

export interface BatchingConfig {
  /** Flush automatically once this many events have queued. */
  maxBatchSize: number;
  /** Flush automatically after this many ms, even if maxBatchSize hasn't been reached. */
  flushIntervalMs: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

const DEFAULT_BATCHING_CONFIG: BatchingConfig = { maxBatchSize: 50, flushIntervalMs: 5_000 };
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxRetries: 3, baseDelayMs: 200 };

/**
 * Common machinery every concrete framework adapter needs (batching,
 * retry-with-backoff, a default health probe) so WO-035/036/037/038 only
 * have to implement the framework-specific parts (validateConnection,
 * translateTelemetry, getAdapterMetadata) — matches this WO's own
 * acceptance criteria: "default implementations... that framework
 * adapters can override."
 */
export abstract class BaseAgentAdapter implements IAgentAdapter {
  private readonly batchingConfig: BatchingConfig;
  private readonly retryConfig: RetryConfig;
  private queue: CanonicalTelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushHandler: ((batch: CanonicalTelemetryEvent[]) => Promise<void>) | null = null;

  protected constructor(batchingConfig: Partial<BatchingConfig> = {}, retryConfig: Partial<RetryConfig> = {}) {
    this.batchingConfig = { ...DEFAULT_BATCHING_CONFIG, ...batchingConfig };
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  abstract validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult>;
  abstract translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent;
  abstract getAdapterMetadata(): AdapterMetadata;

  /** Default: adapters that don't override this report themselves as always healthy — a real framework adapter (WO-035+) overrides this with an actual reachability check. */
  async getHealthProbe(): Promise<HealthProbeResult> {
    return { healthy: true };
  }

  /** Starts periodic auto-flush on the given interval; call `stopBatching()` on shutdown. */
  startBatching(onFlush: (batch: CanonicalTelemetryEvent[]) => Promise<void>): void {
    this.flushHandler = onFlush;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => undefined);
    }, this.batchingConfig.flushIntervalMs);
  }

  stopBatching(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Enqueues an event; auto-flushes once maxBatchSize is reached rather than waiting for the next timer tick. */
  async enqueue(event: CanonicalTelemetryEvent): Promise<void> {
    this.queue.push(event);
    if (this.queue.length >= this.batchingConfig.maxBatchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0 || !this.flushHandler) return;
    const batch = this.queue;
    this.queue = [];
    await this.flushHandler(batch);
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Exponential backoff: baseDelayMs * 2^attempt, retried up to maxRetries times. The final failure propagates to the caller. */
  protected async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt === this.retryConfig.maxRetries) break;
        const delayMs = this.retryConfig.baseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }
}
