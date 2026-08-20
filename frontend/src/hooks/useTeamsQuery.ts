"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { TeamRef } from "@/types/dashboard";

async function fetchTeams(token: string | null): Promise<TeamRef[]> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/teams`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const error = new Error(`Failed to load teams (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const body = (await response.json()) as { teams: TeamRef[] };
  return body.teams;
}

async function createTeam(token: string | null, name: string): Promise<TeamRef> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/teams`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    const error = new Error(body.message ?? `Failed to create team (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<TeamRef>;
}

/** Step 3 (Assign Team)'s own team-assignment dropdown — every accessible team with a member count, via GET /api/v1/teams (implementation_steps' own literal route, distinct from WO-075's dashboard-scoped team selector). */
export function useTeamsQuery() {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["wizard-teams", token],
    queryFn: () => fetchTeams(token),
  });
}

/** AC: "with the option to create a new team if the user has Admin role." */
export function useCreateTeamMutation() {
  const token = useAppStore((s) => s.auth.token);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createTeam(token, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wizard-teams", token] });
    },
  });
}
