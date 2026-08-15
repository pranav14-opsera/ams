"use client";

import { useEffect, useState } from "react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import type { ConnectionState } from "@/types/websocket";
import type { FleetHealthResult } from "@/types/dashboard";

const STALE_AFTER_MS = 30_000; // matches this dashboard's own 30s freshness AC — data older than this is flagged, not silently trusted as current

export interface UseHealthWebSocketResult {
  connectionState: ConnectionState;
  latest: FleetHealthResult | undefined;
  /** true once STALE_AFTER_MS has elapsed since the last received update with no newer one arriving. */
  isStale: boolean;
}

/**
 * Thin wrapper over useRealtimeUpdates("health") (WO-054/055's own
 * connection/batching/reconnect infrastructure already covers auto-
 * reconnect, heartbeat, and tenant-scoped subscription) — this hook adds
 * only what's specific to the health dashboard: typing the "health"
 * channel's payload as FleetHealthResult, and flagging staleness when no
 * update has arrived within this dashboard's own 30-second freshness
 * target.
 */
export function useHealthWebSocket(): UseHealthWebSocketResult {
  const { connectionState, latest } = useRealtimeUpdates<FleetHealthResult>("health");
  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting staleness back to false is an external-sync reaction to `latest` changing (a new update just arrived), not derivable from render; the actual "flip to stale" also happens here, from a timer callback, which the rule doesn't (and shouldn't) flag.
    setIsStale(false);
    if (!latest) return;
    const timer = setTimeout(() => setIsStale(true), STALE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [latest]);

  return { connectionState, latest, isStale };
}
