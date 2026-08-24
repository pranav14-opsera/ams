"use client";

import { useMutation } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface UpsertPoolInput {
  totalCredits: number;
  effectiveMonth: number;
  effectiveYear: number;
}

async function upsertPool(token: string | null, input: UpsertPoolInput): Promise<{ id: string; totalCredits: number }> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/credits/pool`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Failed to provision the credit pool (${response.status})`);
  }
  return response.json() as Promise<{ id: string; totalCredits: number }>;
}

/** Step 5's own credit-pool provisioning — see backend CreditBudgetService.upsertPool's own comment for why onboarding needs this new route ahead of allocate(). */
export function useUpsertCreditPoolMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({ mutationFn: (input: UpsertPoolInput) => upsertPool(token, input) });
}

export interface AllocateBudgetInput {
  teamId: string;
  allocatedCredits: number;
  alertThreshold75: boolean;
  alertThreshold90: boolean;
  effectiveMonth: number;
  effectiveYear: number;
}

async function allocateBudget(token: string | null, input: AllocateBudgetInput): Promise<{ id: string; allocatedCredits: number }> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/credits/allocate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ ...input, hardCap: null, justification: "Initial onboarding allocation" }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Failed to allocate credit budget (${response.status})`);
  }
  return response.json() as Promise<{ id: string; allocatedCredits: number }>;
}

/** Step 5's "configure initial credit budget allocation from the organization's pool" — POST /api/v1/credits/allocate (WO-068). */
export function useAllocateBudgetMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({ mutationFn: (input: AllocateBudgetInput) => allocateBudget(token, input) });
}
