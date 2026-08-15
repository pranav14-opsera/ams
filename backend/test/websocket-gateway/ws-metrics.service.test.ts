import { test } from "node:test";
import assert from "node:assert/strict";
import { WsMetricsService } from "../../src/websocket-gateway/ws-metrics.service";

test("connectionOpened/connectionClosed track websocket_connections_active as a gauge", async () => {
  const metrics = new WsMetricsService();
  metrics.connectionOpened("tenant-1", "dashboard");
  metrics.connectionOpened("tenant-1", "dashboard");
  metrics.connectionClosed("tenant-1", "dashboard");

  const text = await metrics.metricsText();
  assert.ok(text.includes('websocket_connections_active{tenant_id="tenant-1",channel="dashboard"} 1'));
});

test("messageSent increments websocket_messages_sent_total by the batch count", async () => {
  const metrics = new WsMetricsService();
  metrics.messageSent("tenant-1", "alerts", 3);

  const text = await metrics.metricsText();
  assert.ok(text.includes('websocket_messages_sent_total{tenant_id="tenant-1",channel="alerts"} 3'));
});

test("connectionError increments websocket_connection_errors_total by error type", async () => {
  const metrics = new WsMetricsService();
  metrics.connectionError("authentication_failed");
  metrics.connectionError("authentication_failed");
  metrics.connectionError("connection_limit_exceeded");

  const text = await metrics.metricsText();
  assert.ok(text.includes('websocket_connection_errors_total{error_type="authentication_failed"} 2'));
  assert.ok(text.includes('websocket_connection_errors_total{error_type="connection_limit_exceeded"} 1'));
});

test("recordLatencySeconds feeds the websocket_message_latency_seconds histogram", async () => {
  const metrics = new WsMetricsService();
  metrics.recordLatencySeconds(0.05);

  const text = await metrics.metricsText();
  assert.ok(text.includes("websocket_message_latency_seconds_bucket"));
  assert.ok(text.includes("websocket_message_latency_seconds_count 1"));
});
