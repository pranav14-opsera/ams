import type { AlertEvent } from "./alert-threshold.types";

export const CHANNEL_TYPES = ["websocket", "webhook", "email"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const DELIVERY_STATUSES = ["sent", "failed", "retried", "delivered"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface DeliveryResult {
  status: DeliveryStatus;
  latencyMs: number;
  errorMessage: string | null;
  attemptNumber: number;
}

/** WO-060 AC: `deliver(alertEvent, channelConfig)` — every channel implements this same shape. */
export interface AlertChannel<TConfig> {
  readonly channelType: ChannelType;
  deliver(alertEvent: AlertEvent, config: TConfig): Promise<DeliveryResult>;
}
