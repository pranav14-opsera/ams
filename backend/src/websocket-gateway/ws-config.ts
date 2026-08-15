// WO-030's own defaults: 50 connections/tenant, 100ms batch window,
// 30s heartbeat interval with a 10s pong timeout.
export const WS_CONFIG = {
  defaultMaxConnectionsPerTenant: 50,
  batchIntervalMs: 100,
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 10_000,
} as const;

// WebSocket close codes — 4000-4999 is RFC 6455's "private use" range,
// exactly where application-defined codes like these belong.
export const WS_CLOSE_CODE = {
  AUTHENTICATION_REQUIRED: 4001,
  CONNECTION_LIMIT_EXCEEDED: 4029,
} as const;

// Graceful degradation: when the connection is rejected for a reason
// that isn't "you aren't allowed on this channel at all" (i.e. capacity,
// not authorization), the close reason carries a fallback polling
// endpoint the client can fall back to — WebSocket close reasons are
// plain strings (RFC 6455 allows up to 123 UTF-8 bytes), so this is
// simply appended after the machine-readable code.
export const WS_FALLBACK_POLL_PATH = "/api/v1/dashboard/poll";

export const WS_CLOSE_REASON = {
  AUTHENTICATION_REQUIRED: "authentication_required",
  CONNECTION_LIMIT_EXCEEDED: `connection_limit_exceeded;fallback=${WS_FALLBACK_POLL_PATH}`,
} as const;
