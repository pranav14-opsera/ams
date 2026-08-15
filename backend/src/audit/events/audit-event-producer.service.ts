import { Injectable, Logger, Optional } from "@nestjs/common";
import type { CanonicalAuditEvent } from "./canonical-audit-event";
import { KafkaAuditEventProducerService } from "./kafka-audit-event-producer.service";
import type { AuditEventPublisherPort } from "./audit-event-publisher.port";

type CircuitState = "closed" | "open" | "half_open";

const FAILURE_THRESHOLD = 3; // AC: "3-failure threshold"
const OPEN_RESET_MS = 5_000; // AC: "5s timeout"
const DEFAULT_MAX_BUFFER_SIZE = 10_000; // AC: "configurable max size (default 10,000)"
const PUBLISH_RETRY_ATTEMPTS = 3; // AC: "3 retries, exponential backoff"
const RETRY_BASE_DELAY_MS = 50;

export class AuditEventBufferFullError extends Error {
  constructor() {
    super("Audit event producer's in-memory buffer is full — this event was NOT published or buffered and must be routed to the DLQ by the caller.");
    this.name = "AuditEventBufferFullError";
  }
}

/**
 * WO-046's "shared audit event producer SDK" — the class every other
 * bounded context imports to emit canonical audit events. Wraps
 * KafkaAuditEventProducerService with:
 *   1. Per-publish retry (3 attempts, exponential backoff) before a
 *      single publish() call is counted as one circuit-breaker failure.
 *   2. A CLOSED -> OPEN -> HALF_OPEN circuit breaker (same shape as
 *      WO-040's KafkaCircuitBreakerProducerService) — while OPEN,
 *      publish() skips Kafka entirely and buffers in memory.
 *   3. A COUNT-bounded (not time-bounded) in-memory buffer, since this
 *      WO's own AC specifies a max event count (10,000), not a retention
 *      window. When the buffer is full, publish() throws
 *      AuditEventBufferFullError rather than silently evicting an
 *      already-buffered event or dropping the new one — "never silently
 *      dropped" (this WO's own AC) means the caller must see a real
 *      failure it can route to the DLQ, not a false success.
 */
@Injectable()
export class AuditEventProducerService implements AuditEventPublisherPort {
  private readonly logger = new Logger(AuditEventProducerService.name);
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private buffer: CanonicalAuditEvent[] = [];
  private readonly maxBufferSize: number;

  constructor(
    private readonly producer: KafkaAuditEventProducerService,
    @Optional() maxBufferSize?: number,
  ) {
    this.maxBufferSize = maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  getState(): CircuitState {
    return this.state;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  async publish(event: CanonicalAuditEvent): Promise<void> {
    if (this.state === "open" && Date.now() - this.openedAt >= OPEN_RESET_MS) {
      this.state = "half_open";
    }

    if (this.state === "open") {
      this.bufferEvent(event);
      throw new Error("Audit Kafka circuit breaker is open — event buffered locally, publish deferred.");
    }

    try {
      await this.publishWithRetry(event);
      this.onSuccess();
    } catch (err) {
      this.bufferEvent(event);
      this.onFailure(err);
      throw err;
    }
  }

  private async publishWithRetry(event: CanonicalAuditEvent): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PUBLISH_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.producer.publish(event);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < PUBLISH_RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastErr;
  }

  private bufferEvent(event: CanonicalAuditEvent): void {
    if (this.buffer.length >= this.maxBufferSize) {
      this.logger.error(`audit event buffer is full (${this.maxBufferSize} events) — event ${event.event_id} was NOT buffered and must be DLQ'd by the caller.`);
      throw new AuditEventBufferFullError();
    }
    this.buffer.push(event);
  }

  private onSuccess(): void {
    const wasOpenOrHalfOpen = this.state !== "closed";
    this.state = "closed";
    this.consecutiveFailures = 0;

    if (wasOpenOrHalfOpen && this.buffer.length > 0) {
      this.logger.log(`Audit Kafka circuit closed — ${this.buffer.length} buffered event(s) remain queued for the next flush.`);
    }
  }

  /** Best-effort replay of everything currently buffered — called once the circuit is known to be healthy again (e.g. by a scheduled job in a real deployment); never invoked automatically mid-publish, since a flush failure must not silently re-swallow an event this method is trying to drain. */
  async flushBuffer(): Promise<{ flushed: number; remaining: number }> {
    const toFlush = [...this.buffer];
    this.buffer = [];
    let flushed = 0;

    for (const event of toFlush) {
      try {
        await this.producer.publish(event);
        flushed++;
      } catch (err) {
        this.bufferEvent(event);
        this.onFailure(err);
        break;
      }
    }

    return { flushed, remaining: this.buffer.length };
  }

  private onFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open" || this.consecutiveFailures >= FAILURE_THRESHOLD) {
      if (this.state !== "open") {
        this.logger.warn(`Audit Kafka circuit OPENING after ${this.consecutiveFailures} consecutive failures: ${err instanceof Error ? err.message : err}`);
      }
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
