// WO-054's WebSocket protocol — discriminated unions on "type", matching
// the WebSocket Gateway's own message shape (WO-030's server-side
// counterpart). Client -> server: auth, subscribe, unsubscribe, ping.
// Server -> client: auth_ack, data, error, pong.

export interface AuthMessage {
  type: "auth";
  token: string;
}

export interface AuthAckMessage {
  type: "auth_ack";
  success: boolean;
  reason?: string;
}

export interface SubscribeMessage {
  type: "subscribe";
  channel: string;
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  channel: string;
}

export interface DataUpdateMessage<TPayload = unknown> {
  type: "data";
  channel: string;
  payload: TPayload;
  timestamp: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export type ClientMessage = AuthMessage | SubscribeMessage | UnsubscribeMessage | PingMessage;
export type ServerMessage = AuthAckMessage | DataUpdateMessage | ErrorMessage | PongMessage;

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof (value as { type: unknown }).type === "string";
}
