/**
 * A send function decoupled from any concrete transport (raw `ws`,
 * BaseRealtimeGateway's own client map, a test fake) — the subscription
 * layer only ever needs "deliver this payload to this session", never
 * the socket itself.
 */
export type SessionSender = (payload: unknown) => void;

export interface UserSession {
  userId: string;
  tenantId: string;
  role: string;
  permissions: string[];
  subscribedChannels: Set<string>;
  send: SessionSender;
  lastHeartbeat: number;
  connectedAt: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelPermissionRule {
  channel: string;
  /** Empty/absent = every authenticated tenant member may subscribe; otherwise the user needs at least one of these. */
  requiredPermissions?: string[];
}

export interface FanOutResult {
  delivered: string[];
  filtered: string[];
  errors: Array<{ userId: string; error: string }>;
}

/** The envelope shape published onto Kafka topics this bridge consumes — see WO-055 implementation step 9. */
export interface KafkaEventEnvelope {
  tenantId: string;
  channel: string;
  payload: unknown;
}

export class CrossTenantSubscriptionError extends Error {}
