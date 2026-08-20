"use client";

import { useEffect, useState } from "react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import type { ConnectionState } from "@/types/websocket";
import type { OrgUsageUpdateMessage } from "@/types/dashboard";

const STALE_AFTER_MS = 30_000; // matches this dashboard's own 30s freshness AC — data older than this is flagged, not silently trusted as current.

export interface UseOrgUsageSubscriptionResult {
  connectionState: ConnectionState;
  latest: OrgUsageUpdateMessage | undefined;
  /** true once STALE_AFTER_MS has elapsed since the last received update with no newer one arriving. */
  isStale: boolean;
}

/**
 * Thin wrapper over useRealtimeUpdates("org_usage") — same shape as
 * useHealthWebSocket (WO-056). Reuses WO-054/055's own connection/
 * batching (100ms)/reconnect (exponential backoff, handled inside
 * useWebSocket) infrastructure; this hook adds only what's specific to
 * the org usage dashboard: typing the "org_usage" channel's payload as
 * OrgUsageUpdateMessage, and flagging staleness when no update has
 * arrived within the dashboard's own 30-second freshness target
 * (edge_cases: "WebSocket connection drops mid-session — client must
 * auto-reconnect ... and show stale-data indicator until reconnected").
 */
export function useOrgUsageSubscription(): UseOrgUsageSubscriptionResult {
  const { connectionState, latest } = useRealtimeUpdates<OrgUsageUpdateMessage>("org_usage");
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
