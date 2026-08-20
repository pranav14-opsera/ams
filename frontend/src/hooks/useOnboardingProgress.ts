"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { OnboardingProgressResponse } from "@/types/onboarding";

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchProgress(token: string | null, tenantId: string): Promise<OnboardingProgressResponse | null> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/onboarding/${tenantId}/progress`, { headers: authHeaders(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load onboarding progress (${response.status})`);
  return response.json() as Promise<OnboardingProgressResponse>;
}

/** implementation_steps: "restore state on page load with a 'Welcome back — resuming from Step N' message." */
export function useOnboardingProgressQuery(tenantId: string | null) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["onboarding-progress", tenantId],
    queryFn: () => fetchProgress(token, tenantId!),
    enabled: Boolean(tenantId),
  });
}

export interface SaveProgressInput {
  tenantId: string;
  currentStep: number;
  stepData: Record<string, unknown> | import("@/types/onboarding").OnboardingStepData;
  completedSteps: number[];
}

async function saveProgress(token: string | null, input: SaveProgressInput): Promise<{ saved: true; updatedAt: string }> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/onboarding/${input.tenantId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ currentStep: input.currentStep, stepData: input.stepData, completedSteps: input.completedSteps }),
  });
  if (!response.ok) {
    // error_handling: "Progress could not be saved — please do not close this page."
    throw new Error("Progress could not be saved — please do not close this page.");
  }
  return response.json() as Promise<{ saved: true; updatedAt: string }>;
}

/** implementation_steps: "auto-save wizard progress to the server on each step completion and on a 60-second interval." */
export function useSaveOnboardingProgressMutation() {
  const token = useAppStore((s) => s.auth.token);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveProgressInput) => saveProgress(token, input),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding-progress", input.tenantId] });
    },
  });
}

async function restartOnboarding(token: string | null, tenantId: string): Promise<void> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/onboarding/${tenantId}/restart`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!response.ok) throw new Error(`Failed to restart onboarding (${response.status})`);
}

/** edge_case: "if the customer does not complete onboarding within 7 days... offer to restart or contact support." */
export function useRestartOnboardingMutation() {
  const token = useAppStore((s) => s.auth.token);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) => restartOnboarding(token, tenantId),
    onSuccess: (_data, tenantId) => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding-progress", tenantId] });
    },
  });
}
