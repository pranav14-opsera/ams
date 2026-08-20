"use client";

import { useEffect, useState } from "react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import type { ConnectionState } from "@/types/websocket";
import type { TeamUsageUpdateMessage } from "@/types/dashboard";

const STALE_AFTER_MS = 30_000; // Same 30s freshness bound as useOrgUsageSubscription.

export interface UseTeamUsageSubscriptionResult {
  connectionState: ConnectionState;
  latest: TeamUsageUpdateMessage | undefined;
  isStale: boolean;
}

/**
 * Thin wrapper over useRealtimeUpdates("team_usage") — same shape as
 * useOrgUsageSubscription. The "team_usage" pub/sub channel is
 * tenant-wide, not per-team (see TeamUsagePublisherService's own doc
 * comment on why), so every update carries a `teamId` and this hook
 * filters to the team currently being viewed — an update for a
 * different team never overwrites `latest` here.
 */
export function useTeamUsageSubscription(teamId: string | undefined): UseTeamUsageSubscriptionResult {
  const { connectionState, latest: rawLatest } = useRealtimeUpdates<TeamUsageUpdateMessage>("team_usage");
  const [isStale, setIsStale] = useState(false);

  const latest = rawLatest && rawLatest.teamId === teamId ? rawLatest : undefined;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same external-sync reasoning as useOrgUsageSubscription's own identical effect.
    setIsStale(false);
    if (!latest) return;
    const timer = setTimeout(() => setIsStale(true), STALE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [latest]);

  return { connectionState, latest, isStale };
}
