"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { TeamRef, TeamUsageFilters, TeamUsageGranularity, TeamUsagePeriod, TeamUsageSummary } from "@/types/dashboard";

function buildQuery(period: TeamUsagePeriod, granularity: TeamUsageGranularity, teamId: string | undefined, filters: TeamUsageFilters): URLSearchParams {
  const params = new URLSearchParams({ period, granularity });
  if (teamId) params.set("team_id", teamId);
  if (filters.agentIds?.length) params.set("agents", filters.agentIds.join(","));
  if (filters.actionTypes?.length) params.set("action_types", filters.actionTypes.join(","));
  if (filters.frameworks?.length) params.set("frameworks", filters.frameworks.join(","));
  return params;
}

async function fetchTeamUsage(
  token: string | null,
  period: TeamUsagePeriod,
  granularity: TeamUsageGranularity,
  teamId: string | undefined,
  filters: TeamUsageFilters,
): Promise<TeamUsageSummary> {
  const params = buildQuery(period, granularity, teamId, filters);
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/dashboards/usage/team?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Failed to load team usage (${response.status})`);
  }
  return response.json() as Promise<TeamUsageSummary>;
}

async function fetchSelectableTeams(token: string | null): Promise<TeamRef[]> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/dashboards/usage/team/teams`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Failed to load teams (${response.status})`);
  }
  const body = (await response.json()) as { teams: TeamRef[] };
  return body.teams;
}

/** Initial/refetch REST load of the team usage dashboard — same "REST paints the first frame, WebSocket keeps the KPIs live" split as useOrgUsageQuery. Refetches whenever teamId or any filter changes (AC: "all filter changes update the dashboard within 2 seconds"). */
export function useTeamUsageQuery(period: TeamUsagePeriod, granularity: TeamUsageGranularity, teamId: string | undefined, filters: TeamUsageFilters) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["team-usage", token, period, granularity, teamId, filters.agentIds, filters.actionTypes, filters.frameworks],
    queryFn: () => fetchTeamUsage(token, period, granularity, teamId, filters),
  });
}

/** Backs the team selector — every team in the tenant for an org-scoped caller, only the caller's own team(s) otherwise (server-enforced, see TeamUsageDashboardService.listSelectableTeams). */
export function useSelectableTeamsQuery() {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["team-usage-selectable-teams", token],
    queryFn: () => fetchSelectableTeams(token),
  });
}
