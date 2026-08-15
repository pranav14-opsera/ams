import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

@Injectable()
export class WsMetricsService {
  readonly registry = new Registry();

  private readonly connectionsActive = new Gauge({
    name: "websocket_connections_active",
    help: "Currently open WebSocket connections, by tenant and channel.",
    labelNames: ["tenant_id", "channel"],
    registers: [this.registry],
  });

  private readonly messagesSentTotal = new Counter({
    name: "websocket_messages_sent_total",
    help: "Total WebSocket messages delivered, by tenant and channel.",
    labelNames: ["tenant_id", "channel"],
    registers: [this.registry],
  });

  private readonly connectionErrorsTotal = new Counter({
    name: "websocket_connection_errors_total",
    help: "Total WebSocket connection errors, by error type.",
    labelNames: ["error_type"],
    registers: [this.registry],
  });

  private readonly messageLatencySeconds = new Histogram({
    name: "websocket_message_latency_seconds",
    help: "Time from a message being published to Redis until it is delivered to a connected client.",
    buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1],
    registers: [this.registry],
  });

  connectionOpened(tenantId: string, channel: string): void {
    this.connectionsActive.inc({ tenant_id: tenantId, channel });
  }

  connectionClosed(tenantId: string, channel: string): void {
    this.connectionsActive.dec({ tenant_id: tenantId, channel });
  }

  messageSent(tenantId: string, channel: string, count = 1): void {
    this.messagesSentTotal.inc({ tenant_id: tenantId, channel }, count);
  }

  connectionError(errorType: string): void {
    this.connectionErrorsTotal.inc({ error_type: errorType });
  }

  recordLatencySeconds(seconds: number): void {
    this.messageLatencySeconds.observe(seconds);
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
