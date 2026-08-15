"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AuthAckMessage, ClientMessage, ConnectionState, ServerMessage } from "@/types/websocket";
import { isServerMessage } from "@/types/websocket";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;

export interface UseWebSocketOptions {
  onMessage?: (message: ServerMessage) => void;
  /**
   * Called synchronously as the first step of teardown, before the
   * socket is closed — e.g. so a caller (useRealtimeUpdates) can send an
   * unsubscribe message while the connection is still open. Effect
   * cleanup ORDER between two separate hooks in the same component isn't
   * something to rely on for "run my cleanup before this one closes the
   * socket"; this callback makes that ordering explicit instead.
   */
  onBeforeClose?: () => void;
}

export interface UseWebSocketResult {
  state: ConnectionState;
  retryCount: number;
  send: (message: ClientMessage) => void;
  disconnect: () => void;
}

/** AC: 1s, 2s, 4s, 8s, 16s, capped at 30s. */
function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/**
 * AC: the core WebSocket connection lifecycle — connect, authenticate,
 * heartbeat, reconnect with exponential backoff, clean disconnect. A
 * single hook instance owns exactly one physical connection;
 * useRealtimeUpdates (channel subscriptions) is layered on top via the
 * shared realtime-store rather than each channel opening its own socket.
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketResult {
  const token = useAppStore((s) => s.auth.token);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [retryCount, setRetryCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const onMessageRef = useRef(options.onMessage);
  const tokenRef = useRef(token);
  const onBeforeCloseRef = useRef(options.onBeforeClose);
  useEffect(() => {
    onMessageRef.current = options.onMessage;
    tokenRef.current = token;
    onBeforeCloseRef.current = options.onBeforeClose;
  }, [options.onMessage, options.onBeforeClose, token]);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
    heartbeatIntervalRef.current = null;
    pongTimeoutRef.current = null;
  }, []);

  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    clearHeartbeat();
    heartbeatIntervalRef.current = setInterval(() => {
      send({ type: "ping" });
      pongTimeoutRef.current = setTimeout(() => {
        // No pong within the window — treat the connection as dead.
        wsRef.current?.close();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }, [clearHeartbeat, send]);

  const connectRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    function scheduleReconnect() {
      if (retryCountRef.current >= MAX_RETRY_ATTEMPTS) {
        setState("error");
        return;
      }
      setState("reconnecting");
      const delay = backoffDelay(retryCountRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        retryCountRef.current += 1;
        setRetryCount(retryCountRef.current);
        connectRef.current();
      }, delay);
    }

    function connect() {
      setState((prev) => (prev === "reconnecting" ? prev : "connecting"));
      const ws = new WebSocket(env.NEXT_PUBLIC_WS_BASE_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (tokenRef.current) {
          ws.send(JSON.stringify({ type: "auth", token: tokenRef.current } satisfies ClientMessage));
        }
      };

      ws.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (!isServerMessage(parsed)) return;

        if (parsed.type === "auth_ack") {
          const ack = parsed as AuthAckMessage;
          if (ack.success) {
            setState("connected");
            retryCountRef.current = 0;
            setRetryCount(0);
            startHeartbeat();
          } else {
            setState("error");
          }
          return;
        }

        if (parsed.type === "pong") {
          if (pongTimeoutRef.current) {
            clearTimeout(pongTimeoutRef.current);
            pongTimeoutRef.current = null;
          }
          return;
        }

        onMessageRef.current?.(parsed);
      };

      ws.onclose = () => {
        clearHeartbeat();
        if (intentionalCloseRef.current) {
          setState("disconnected");
          return;
        }
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose always follows onerror for a WebSocket — reconnection is handled there.
      };
    }

    connectRef.current = connect;
    intentionalCloseRef.current = false;
    connect();

    return () => {
      intentionalCloseRef.current = true;
      onBeforeCloseRef.current?.();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearHeartbeat();
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally a single mount-time effect; token/onMessage changes are read via refs so they don't tear down and reopen the live connection.
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    onBeforeCloseRef.current?.();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    clearHeartbeat();
    wsRef.current?.close();
  }, [clearHeartbeat]);

  return { state, retryCount, send, disconnect };
}
