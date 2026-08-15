import { Injectable, Logger } from "@nestjs/common";
import type { CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";
import { KafkaTelemetryProducerService } from "./kafka-telemetry-producer.service";
import type { TelemetryPublisherPort } from "./telemetry-publisher.port";

type CircuitState = "closed" | "open" | "half_open";

const FAILURE_THRESHOLD = 3; // AC (WO-040): "activates after 3 consecutive failures"
const OPEN_RESET_MS = 5_000; // AC: "5-second timeout"
const BUFFER_RETENTION_MS = 5 * 60 * 1000; // AC: "buffered locally for up to 5 minutes"

interface BufferedEvent {
  event: CanonicalTelemetryEvent;
  bufferedAt: number;
}

/**
 * Wraps KafkaTelemetryProducerService with a 3-failure-threshold circuit
 * breaker (CLOSED -> OPEN -> HALF_OPEN, same state machine shape as
 * WO-027's CircuitBreakerRateLimiterService, adapted to this WO-040's own
 * thresholds): while OPEN, publish() fails fast without even attempting
 * Kafka (avoiding repeated slow-timeout attempts against a broker that's
 * already known to be down) and buffers the event in memory; once
 * OPEN_RESET_MS has elapsed, the next publish() probes Kafka once
 * (HALF_OPEN) — success closes the circuit and flushes the buffer
 * (replaying anything not older than BUFFER_RETENTION_MS; anything older
 * is dropped with a warning, since it's a "fast recovery" path, not the
 * durable record), failure re-opens it.
 *
 * This sits ALONGSIDE (not instead of) TelemetryPipelineService's
 * existing Postgres dead-letter fallback (WO-034): every publish()
 * failure here still propagates to the caller, so the pipeline's own
 * DLQ write still happens as the durable, permanent record — the
 * in-memory buffer here is purely a best-effort fast-recovery path for
 * the common case of a brief Kafka blip.
 */
@Injectable()
export class KafkaCircuitBreakerProducerService implements TelemetryPublisherPort {
  private readonly logger = new Logger(KafkaCircuitBreakerProducerService.name);
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private buffer: BufferedEvent[] = [];

  constructor(private readonly producer: KafkaTelemetryProducerService) {}

  getState(): CircuitState {
    return this.state;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  async publish(event: CanonicalTelemetryEvent): Promise<void> {
    if (this.state === "open" && Date.now() - this.openedAt >= OPEN_RESET_MS) {
      this.state = "half_open";
    }

    if (this.state === "open") {
      this.bufferEvent(event);
      throw new Error("Kafka circuit breaker is open — event buffered locally, publish deferred.");
    }

    try {
      await this.producer.publish(event);
      await this.onSuccess();
    } catch (err) {
      this.bufferEvent(event);
      this.onFailure(err);
      throw err;
    }
  }

  private bufferEvent(event: CanonicalTelemetryEvent): void {
    const now = Date.now();
    this.buffer = this.buffer.filter((b) => now - b.bufferedAt <= BUFFER_RETENTION_MS);
    this.buffer.push({ event, bufferedAt: now });
  }

  private async onSuccess(): Promise<void> {
    const wasOpenOrHalfOpen = this.state !== "closed";
    this.state = "closed";
    this.consecutiveFailures = 0;

    if (wasOpenOrHalfOpen && this.buffer.length > 0) {
      this.logger.log(`Kafka circuit closed — flushing ${this.buffer.length} buffered event(s)`);
      await this.flushBuffer();
    }
  }

  private async flushBuffer(): Promise<void> {
    const now = Date.now();
    const toFlush = this.buffer.filter((b) => now - b.bufferedAt <= BUFFER_RETENTION_MS);
    const expiredCount = this.buffer.length - toFlush.length;
    if (expiredCount > 0) {
      this.logger.warn(`${expiredCount} buffered telemetry event(s) exceeded the 5-minute retention window and were dropped (still recorded in the dead-letter table by the caller).`);
    }
    this.buffer = [];

    for (const { event } of toFlush) {
      try {
        await this.producer.publish(event);
      } catch {
        // A flush failure here re-opens the circuit via the normal
        // publish() path on the NEXT real event — this loop doesn't
        // retry indefinitely, it's a one-shot best-effort replay.
        this.bufferEvent(event);
        this.onFailure(new Error("buffer flush failed"));
        break;
      }
    }
  }

  private onFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open" || this.consecutiveFailures >= FAILURE_THRESHOLD) {
      if (this.state !== "open") {
        this.logger.warn(`Kafka circuit OPENING after ${this.consecutiveFailures} consecutive failures: ${err instanceof Error ? err.message : err}`);
      }
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
