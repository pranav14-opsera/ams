import { Logger, type OnModuleDestroy } from "@nestjs/common";
import type { OnGatewayConnection, OnGatewayDisconnect } from "@nestjs/websockets";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type WebSocket from "ws";
import { ConnectionRegistryService } from "../connection-registry.service";
import { MessageBatcherService } from "../message-batcher.service";
import { RedisPubSubService } from "../redis-pubsub.service";
import { isAuthorizedForMessage } from "../role-filter";
import { WsAuthService } from "../ws-auth.service";
import { WsMetricsService } from "../ws-metrics.service";
import { WS_CLOSE_CODE, WS_CLOSE_REASON, WS_CONFIG } from "../ws-config";
import { WsConnectionLimitConfigService } from "../ws-connection-limit-config.service";

interface RealtimeMessage {
  requiredRoles?: string[];
  payload: unknown;
}

/**
 * Shared connection lifecycle for all three real-time channels
 * (/ws/dashboard, /ws/alerts, /ws/approvals) — JWT handshake auth,
 * per-tenant connection limit enforcement, Redis pub/sub subscription,
 * 100ms message batching, role-aware filtering, and a heartbeat that
 * closes stale connections. Each concrete gateway subclass only
 * supplies its own `@WebSocketGateway({ path })` decorator and channel
 * name — see dashboard.gateway.ts for the thin subclass shape.
 */
export abstract class BaseRealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  protected abstract readonly channel: string;
  protected readonly logger = new Logger(this.constructor.name);

  private readonly heartbeats = new Map<string, { alive: boolean; interval: NodeJS.Timeout }>();
  private readonly clients = new Map<string, WebSocket>();

  constructor(
    protected readonly authService: WsAuthService,
    protected readonly connectionRegistry: ConnectionRegistryService,
    protected readonly pubsub: RedisPubSubService,
    protected readonly batcher: MessageBatcherService,
    protected readonly metrics: WsMetricsService,
    protected readonly connectionLimitConfig: WsConnectionLimitConfigService,
  ) {}

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    let identity;
    try {
      identity = await this.authService.authenticate(request.url);
    } catch (err) {
      this.metrics.connectionError("authentication_failed");
      this.close(client, WS_CLOSE_CODE.AUTHENTICATION_REQUIRED, WS_CLOSE_REASON.AUTHENTICATION_REQUIRED);
      this.logger.warn(`security event: WebSocket handshake rejected on ${this.channel} — ${err instanceof Error ? err.message : err}`);
      return;
    }

    const connectionId = randomUUID();
    const maxConnections = this.connectionLimitConfig.getLimit(identity.tenantId);
    const acquired = await this.connectionRegistry.acquire(
      { connectionId, tenantId: identity.tenantId, userId: identity.userId, roles: identity.roles, channel: this.channel },
      maxConnections,
    );

    if (!acquired) {
      this.metrics.connectionError("connection_limit_exceeded");
      this.close(client, WS_CLOSE_CODE.CONNECTION_LIMIT_EXCEEDED, WS_CLOSE_REASON.CONNECTION_LIMIT_EXCEEDED);
      return;
    }

    (client as any).__connectionId = connectionId;
    this.clients.set(connectionId, client);
    this.metrics.connectionOpened(identity.tenantId, this.channel);

    const messageHandler = (message: unknown) => this.deliver(connectionId, identity.tenantId, identity.roles, message as RealtimeMessage);
    await this.pubsub.subscribe(identity.tenantId, this.channel, messageHandler);
    (client as any).__unsubscribe = () => this.pubsub.unsubscribe(identity.tenantId, this.channel, messageHandler);

    this.startHeartbeat(client, connectionId);
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    const connectionId = (client as any).__connectionId as string | undefined;
    if (!connectionId) return;

    const info = this.connectionRegistry.getLocalConnection(connectionId);
    this.stopHeartbeat(connectionId);
    this.batcher.clear(connectionId);
    this.clients.delete(connectionId);
    await (client as any).__unsubscribe?.();
    await this.connectionRegistry.release(connectionId);

    if (info) this.metrics.connectionClosed(info.tenantId, this.channel);
  }

  /** A Redis-delivered message for a message that arrived at THIS connection — applies role filtering, then hands off to the 100ms batcher. */
  private deliver(connectionId: string, tenantId: string, userRoles: string[], message: RealtimeMessage): void {
    if (!isAuthorizedForMessage(message.requiredRoles, userRoles)) return;

    // WO-044: websocket_message_latency_seconds existed (ws-metrics.service.ts)
    // but was never actually fed by the real delivery path — this is the
    // in-process portion of that latency (message arrival at this
    // connection's handler -> batch flush actually sent to the client),
    // i.e. the cost the 100ms batching window itself adds. It does not
    // include the Redis publish->subscribe network hop, which happens
    // before `message` ever reaches this method.
    const deliverStartedAtMs = Date.now();

    this.batcher.enqueue(connectionId, message.payload, (batch) => {
      const client = this.clients.get(connectionId);
      if (!client || client.readyState !== client.OPEN) return;
      client.send(JSON.stringify({ channel: this.channel, batch }));
      this.metrics.messageSent(tenantId, this.channel, batch.length);
      this.metrics.recordLatencySeconds((Date.now() - deliverStartedAtMs) / 1000);
    });
  }

  private startHeartbeat(client: WebSocket, connectionId: string): void {
    const state = { alive: true, interval: null as unknown as NodeJS.Timeout };
    client.on("pong", () => {
      state.alive = true;
    });

    state.interval = setInterval(() => {
      if (!state.alive) {
        this.logger.warn(`heartbeat timeout — closing stale connection ${connectionId} on ${this.channel}`);
        client.terminate();
        return;
      }
      state.alive = false;
      client.ping();
    }, WS_CONFIG.heartbeatIntervalMs);
    state.interval.unref?.();

    this.heartbeats.set(connectionId, state);
  }

  private stopHeartbeat(connectionId: string): void {
    const state = this.heartbeats.get(connectionId);
    if (!state) return;
    clearInterval(state.interval);
    this.heartbeats.delete(connectionId);
  }

  private close(client: WebSocket, code: number, reason: string): void {
    try {
      client.close(code, reason);
    } catch {
      client.terminate();
    }
  }

  /** Graceful shutdown (SIGTERM): every locally-held connection gets a real close frame (1001 "going away") rather than the process just dying underneath them. */
  onModuleDestroy(): void {
    for (const client of this.clients.values()) {
      this.close(client, 1001, "server_shutting_down");
    }
  }
}
