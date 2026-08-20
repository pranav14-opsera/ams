"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { OrgUsageSummary, UsageGranularity, UsagePeriod } from "@/types/dashboard";

async function fetchOrgUsage(token: string | null, period: UsagePeriod, granularity: UsageGranularity): Promise<OrgUsageSummary> {
  const params = new URLSearchParams({ period, granularity });
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/dashboards/usage/org?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Failed to load organization usage (${response.status})`);
  }
  return response.json() as Promise<OrgUsageSummary>;
}

/** Initial/refetch REST load of the org usage dashboard — the live/incremental picture comes from useOrgUsageSubscription instead (same "prefer real-time over background refetch" default as useFleetHealthQuery). */
export function useOrgUsageQuery(period: UsagePeriod, granularity: UsageGranularity) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["org-usage", token, period, granularity],
    queryFn: () => fetchOrgUsage(token, period, granularity),
  });
}
