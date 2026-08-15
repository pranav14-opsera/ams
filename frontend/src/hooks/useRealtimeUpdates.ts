"use client";

import { useEffect, useRef } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useWebSocketBatcher } from "@/hooks/useWebSocketBatcher";
import { useRealtimeStore } from "@/stores/realtime-store";
import type { ConnectionState, DataUpdateMessage, ServerMessage } from "@/types/websocket";

export interface UseRealtimeUpdatesResult<TPayload> {
  connectionState: ConnectionState;
  latest: TPayload | undefined;
}

/**
 * AC: subscribes to one channel, delivers 100ms-batched typed updates.
 * Per implementation_steps, this hook itself owns the useWebSocket call
 * (per its own literal wording) — every call site therefore opens its
 * own physical connection today. Sharing a single connection across
 * multiple useRealtimeUpdates call sites (a WebSocketProvider/context)
 * is a natural follow-up once more than one dashboard widget subscribes
 * simultaneously; not built here since no such caller exists yet.
 */
export function useRealtimeUpdates<TPayload = unknown>(channel: string, onUpdate?: (payload: TPayload) => void): UseRealtimeUpdatesResult<TPayload> {
  const setConnectionState = useRealtimeStore((s) => s.setConnectionState);
  const addSubscription = useRealtimeStore((s) => s.addSubscription);
  const removeSubscription = useRealtimeStore((s) => s.removeSubscription);
  const setLatest = useRealtimeStore((s) => s.setLatest);
  const latest = useRealtimeStore((s) => s.latestByChannel.get(channel) as TPayload | undefined);

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const { enqueue } = useWebSocketBatcher<TPayload>((batch) => {
    // Only the last update in a batch is meaningful for a "latest value" store — earlier ones were already superseded.
    const last = batch[batch.length - 1];
    if (last === undefined) return;
    setLatest(channel, last);
    onUpdateRef.current?.(last);
  });

  const handleMessage = (message: ServerMessage) => {
    if (message.type !== "data") return;
    const dataMessage = message as DataUpdateMessage<TPayload>;
    if (dataMessage.channel !== channel) return;
    enqueue(dataMessage.payload);
  };

  // Tracks whether THIS hook instance has an active subscription — used
  // by onBeforeClose so the unsubscribe send happens synchronously as
  // part of useWebSocket's own teardown (guaranteed to run while the
  // socket is still open), rather than racing a separate effect's
  // cleanup against useWebSocket's own socket-closing cleanup.
  const isSubscribedRef = useRef(false);

  const { state, send } = useWebSocket({
    onMessage: handleMessage,
    onBeforeClose: () => {
      if (isSubscribedRef.current) {
        send({ type: "unsubscribe", channel });
        removeSubscription(channel);
        isSubscribedRef.current = false;
      }
    },
  });

  useEffect(() => {
    setConnectionState(state);
  }, [state, setConnectionState]);

  useEffect(() => {
    if (state !== "connected") return;
    send({ type: "subscribe", channel });
    addSubscription(channel);
    isSubscribedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send/addSubscription are stable (Zustand actions / useCallback); re-running only on state/channel change is intentional. Unsubscribe itself is handled by onBeforeClose above, not this effect's own cleanup.
  }, [state, channel]);

  return { connectionState: state, latest };
}
