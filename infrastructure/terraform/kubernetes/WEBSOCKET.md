# WebSocket Gateway (WO-030)

Real-time dashboard push for `/ws/dashboard`, `/ws/alerts`, and
`/ws/approvals` — implemented in `backend/src/websocket-gateway/`.

## Where this actually runs

This platform is currently one NestJS process (`backend/`), not yet
split into per-bounded-context microservices — the same reality
WO-026's `GATEWAY.md` documents for its routing table. The WebSocket
gateway is a module *within* that same process
(`WebsocketGatewayModule`, registered in `app.module.ts`), using
`@nestjs/platform-ws`'s `WsAdapter` (raw WebSocket protocol, not
socket.io — this WO's acceptance criteria need real WebSocket close
codes like 4001/4029 on the wire, which socket.io's own framing would
obscure).

The Ingress (`gateway-routes.tf`'s `kubernetes_ingress_v1.websocket_gateway`)
routes `/ws/*` to the same `ams-backend` service the REST API uses, with
a 3600s `proxy-read-timeout`/`proxy-send-timeout` override — the default
60s would silently kill every idle WebSocket connection. If/when this
becomes a genuinely separate deployment (its own Helm release, HPA
scaling on `websocket_connections_active` rather than the REST API's
CPU-based scaling), only `var.gateway_route_backends`'s entries and this
Ingress's backend service name need to change — no Ingress-resource
restructuring, the same design GATEWAY.md's routing table already
anticipated for other feature areas.

## What's implemented

- **JWT handshake auth** (`ws-auth.service.ts`): the JWT travels as a
  `?token=` query parameter (browsers can't set a custom header on the
  WebSocket handshake) and is verified with the SAME RS256/JWKS-rotation
  -aware verifier (`MultiKeyJwtVerifier`, WO-019) the REST API uses — no
  second, independent JWT implementation. Missing/invalid/expired tokens
  close with code 4001, reason `authentication_required`.
- **Per-tenant connection limits** (`connection-registry.service.ts`):
  a Redis atomic INCR-with-limit Lua script enforces the default-50
  ceiling across every gateway pod replica (not just the process that
  happens to receive the connection), with a JSON env var
  (`TENANT_WS_CONNECTION_LIMIT_OVERRIDES`) for per-tenant overrides —
  deliberately a SEPARATE config from WO-027's per-tenant *request-rate*
  overrides (a connection-count ceiling and a requests/second ceiling
  are different units; conflating them would be a real bug). Exceeding
  the limit closes with code 4029, reason `connection_limit_exceeded`.
- **Cross-instance message routing** (`redis-pubsub.service.ts`): real
  Redis pub/sub on tenant-and-channel-scoped topics, using separate
  publisher/subscriber connections (a subscribing ioredis connection
  can't issue any other command).
- **100ms message batching** (`message-batcher.service.ts`): messages
  arriving within the same 100ms window for one connection are
  aggregated into a single WebSocket frame.
- **Role-aware filtering** (`role-filter.ts`): a message's
  `requiredRoles` is checked against the connected user's roles before
  delivery — e.g. a Finance Manager never receives agent trace data.
- **Heartbeat**: 30s ping interval, connections that miss a pong within
  the next interval are terminated.
- **Graceful shutdown**: each gateway's `onModuleDestroy` sends a real
  close frame (code 1001) to every locally-held connection; `main.ts`
  calls `app.enableShutdownHooks()` so SIGTERM actually triggers it.
- **Prometheus metrics** (`ws-metrics.service.ts`, merged into the
  existing `/metrics` endpoint from WO-027): `websocket_connections_active`,
  `websocket_messages_sent_total`, `websocket_connection_errors_total`,
  `websocket_message_latency_seconds`.

## What this cannot validate without a live deployment

- **1,000 concurrent connections across 5 tenants at 100 msg/s, P99
  <500ms, zero message loss** — this WO's own load-test acceptance
  criterion requires a real k6 (or similar) run against a deployed
  gateway; this sandbox's tests prove correctness (atomicity, isolation,
  batching, filtering) against a real local Redis, not throughput at
  that scale.
- **Graceful degradation**: implemented as a fallback polling path
  (`/api/v1/dashboard/poll`) appended to the close reason on capacity
  rejection (`ws-config.ts`'s `WS_CLOSE_REASON.CONNECTION_LIMIT_EXCEEDED`
  — WebSocket close reasons are plain strings, RFC 6455 allows up to 123
  UTF-8 bytes). No dashboard REST polling endpoint exists yet in this
  repository to serve that path (dashboards aren't a built feature area
  yet) — the MECHANISM a real client would branch on is what's
  implemented and tested here, same "build the real, working piece;
  document the not-yet-built downstream consumer" pattern as elsewhere
  in this codebase.
