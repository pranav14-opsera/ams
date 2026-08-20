"use client";

import { useCallback, useEffect, useState } from "react";
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

/** A genuine fleet-health snapshot (HealthMetricsPublisherService) never carries a `type` discriminant — only WO-079's shape-tagged `agent_status_update` messages do, sharing this same "health" channel (see useAgentHealthSocket's own doc comment on why). */
function isFleetHealthSnapshot(payload: unknown): payload is FleetHealthResult {
  return typeof payload === "object" && payload !== null && !("type" in payload);
}

/**
 * Thin wrapper over useRealtimeUpdates("health") (WO-054/055's own
 * connection/batching/reconnect infrastructure already covers auto-
 * reconnect, heartbeat, and tenant-scoped subscription) — this hook adds
 * only what's specific to the health dashboard: typing the "health"
 * channel's payload as FleetHealthResult, and flagging staleness when no
 * update has arrived within this dashboard's own 30-second freshness
 * target.
 *
 * WO-079 added a second, shape-tagged message kind
 * (`agent_status_update`) onto this SAME channel — `useRealtimeUpdates`
 * keys its "latest" store slot purely by channel name, so without
 * filtering, this hook's own `latest` would occasionally become that
 * other message shape (whichever arrived last in a 100ms batch window)
 * instead of a real snapshot, breaking every consumer of `latest.agents`.
 * `onUpdate` here maintains this hook's OWN locally-filtered state
 * instead of trusting the shared store's raw `latest`.
 */
export function useHealthWebSocket(): UseHealthWebSocketResult {
  const [latest, setLatest] = useState<FleetHealthResult | undefined>(undefined);
  const onUpdate = useCallback((payload: unknown) => {
    if (isFleetHealthSnapshot(payload)) setLatest(payload);
  }, []);
  const { connectionState } = useRealtimeUpdates<unknown>("health", onUpdate);
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
