"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AgentHealthFilters, FleetHealthResult } from "@/types/dashboard";

const PAGE_SIZE = 100;

function buildQueryString(filters: AgentHealthFilters, offset: number): string {
  const params = new URLSearchParams();
  if (filters.teamId) params.set("teamId", filters.teamId);
  if (filters.framework) params.set("framework", filters.framework);
  if (filters.status) params.set("status", filters.status);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  return `?${params.toString()}`;
}

async function fetchFleetHealthPage(token: string | null, filters: AgentHealthFilters, offset: number): Promise<FleetHealthResult> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/health${buildQueryString(filters, offset)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) throw new Error(`Failed to load fleet health (${response.status})`);
  return response.json() as Promise<FleetHealthResult>;
}

/**
 * AC: progressive data loading — page 1 on mount, subsequent pages
 * prefetched as the user scrolls (VirtualizedAgentGrid's onLoadMore,
 * wired to fetchNextPage, fires once scroll reaches 80% of the viewport).
 * Offset-based (not a real opaque cursor) since DashboardService's own
 * pagination is already offset-based (limit/offset) — no new backend
 * pagination scheme invented for this WO.
 */
export function useFleetHealthInfiniteQuery(filters: AgentHealthFilters) {
  const token = useAppStore((s) => s.auth.token);
  return useInfiniteQuery({
    queryKey: ["fleet-health-infinite", token, filters],
    queryFn: ({ pageParam }) => fetchFleetHealthPage(token, filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loadedSoFar = allPages.reduce((sum, page) => sum + page.agents.length, 0);
      return loadedSoFar < lastPage.total ? loadedSoFar : undefined;
    },
  });
}
