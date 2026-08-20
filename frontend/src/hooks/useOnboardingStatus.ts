"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { OnboardingStatus } from "@/types/onboarding";

async function fetchStatus(token: string | null, tenantId: string): Promise<OnboardingStatus> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/onboarding/${tenantId}/status`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) throw new Error(`Failed to load verification status (${response.status})`);
  return response.json() as Promise<OnboardingStatus>;
}

/** Step 6: GET /api/v1/onboarding/{tenantId}/status — the "Re-run Checks" button just refetches this query. */
export function useOnboardingStatusQuery(tenantId: string | null) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["onboarding-status", tenantId],
    queryFn: () => fetchStatus(token, tenantId!),
    enabled: Boolean(tenantId),
  });
}

export function useInvalidateOnboardingStatus(tenantId: string | null) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["onboarding-status", tenantId] });
}
