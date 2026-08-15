"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AgentHealthFilters, FleetHealthResult } from "@/types/dashboard";

function buildQueryString(filters: AgentHealthFilters): string {
  const params = new URLSearchParams();
  if (filters.teamId) params.set("teamId", filters.teamId);
  if (filters.framework) params.set("framework", filters.framework);
  if (filters.status) params.set("status", filters.status);
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function fetchFleetHealth(token: string | null, filters: AgentHealthFilters): Promise<FleetHealthResult> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/health${buildQueryString(filters)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Failed to load fleet health (${response.status})`);
  }
  return response.json() as Promise<FleetHealthResult>;
}

/** Initial/refetch REST load of the fleet health dashboard — the live/incremental picture comes from useHealthWebSocket instead (this platform's own "prefer real-time over background refetch" default, per query-provider.tsx's own comment). */
export function useFleetHealthQuery(filters: AgentHealthFilters) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["fleet-health", token, filters],
    queryFn: () => fetchFleetHealth(token, filters),
  });
}
