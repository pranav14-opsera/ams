"use client";

import { useRealtimeStore } from "@/stores/realtime-store";
import type { ConnectionState } from "@/types/websocket";
import { cn } from "@/lib/utils";

const STATE_CONFIG: Record<ConnectionState, { color: string; label: string }> = {
  connected: { color: "bg-green-500", label: "Connected" },
  connecting: { color: "bg-yellow-500", label: "Connecting" },
  reconnecting: { color: "bg-yellow-500", label: "Reconnecting" },
  disconnected: { color: "bg-red-500", label: "Disconnected" },
  error: { color: "bg-red-500", label: "Connection error" },
};

/**
 * AC: green/yellow/red dot with a tooltip (state, last connected time,
 * retry count), aria-live="polite" so screen readers hear state changes
 * without needing to poll. `title` doubles as a lightweight native
 * tooltip — no separate Tooltip primitive installed yet for this WO's
 * scope.
 */
export function ConnectionStatusIndicator() {
  const connectionState = useRealtimeStore((s) => s.connectionState);
  const reconnectAttempts = useRealtimeStore((s) => s.reconnectAttempts);
  const lastConnectedAt = useRealtimeStore((s) => s.lastConnectedAt);
  const { color, label } = STATE_CONFIG[connectionState];

  const tooltip = [
    `Status: ${label}`,
    lastConnectedAt ? `Last connected: ${new Date(lastConnectedAt).toLocaleTimeString()}` : "Never connected",
    reconnectAttempts > 0 ? `Retry attempts: ${reconnectAttempts}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className="inline-flex items-center gap-2" title={tooltip}>
      <span aria-hidden="true" className={cn("size-2.5 rounded-full", color)} />
      <span aria-live="polite" className="sr-only">
        {label}
      </span>
    </span>
  );
}
