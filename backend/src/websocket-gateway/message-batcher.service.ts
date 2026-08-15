import { Injectable } from "@nestjs/common";
import { WS_CONFIG } from "./ws-config";

interface BatchState {
  buffer: unknown[];
  timer: NodeJS.Timeout;
}

/**
 * 100ms debounce per connection (WO-030's own spec) — multiple metric
 * updates arriving within the window are aggregated into ONE WebSocket
 * frame (an array), preventing the render-thrashing a naive "send every
 * update immediately" approach would cause on a busy dashboard.
 */
@Injectable()
export class MessageBatcherService {
  private readonly states = new Map<string, BatchState>();

  /** Queues a message for `connectionId`; `flush` is called with the accumulated batch once, ~100ms after the FIRST message in this batch arrived. */
  enqueue(connectionId: string, message: unknown, flush: (batch: unknown[]) => void): void {
    const existing = this.states.get(connectionId);
    if (existing) {
      existing.buffer.push(message);
      return;
    }

    const buffer = [message];
    const timer = setTimeout(() => {
      this.states.delete(connectionId);
      flush(buffer);
    }, WS_CONFIG.batchIntervalMs);
    // Never keeps the process alive on its own — a pending flush must
    // not block graceful shutdown.
    timer.unref?.();

    this.states.set(connectionId, { buffer, timer });
  }

  /** Cancels any pending batch for a connection without flushing — used on disconnect, so a stale timer doesn't fire against a closed socket. */
  clear(connectionId: string): void {
    const existing = this.states.get(connectionId);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.states.delete(connectionId);
  }

  hasPending(connectionId: string): boolean {
    return this.states.has(connectionId);
  }
}
