"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AgentLifecycleStatus, ApiErrorBody, BulkLifecycleResponse } from "@/types/dashboard";

export class BulkLifecycleError extends Error {
  status: number;
  body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, message: string) {
    super(message);
    this.name = "BulkLifecycleError";
    this.status = status;
    this.body = body;
  }
}

export interface BulkLifecycleVariables {
  agentIds: string[];
  targetStatus: AgentLifecycleStatus;
  justification?: string;
}

// constraints: "bulk operations within 30 seconds for up to 50 agents" —
// matches BulkLifecycleService's own BULK_LIFECYCLE_TIMEOUT_MS server-side
// budget; a small margin is added client-side so the server's own timeout
// response (a real 200 with per-agent timeout failures, not a network
// error) has a chance to arrive first.
export const BULK_LIFECYCLE_TIMEOUT_MS = 35_000;

async function bulkTransitionLifecycle(token: string | null, { agentIds, targetStatus, justification }: BulkLifecycleVariables): Promise<BulkLifecycleResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BULK_LIFECYCLE_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/bulk-lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ agentIds, targetStatus, justification }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new BulkLifecycleError(response.status, body, body?.message ?? `Bulk lifecycle operation failed (${response.status}).`);
    }

    return response.json() as Promise<BulkLifecycleResponse>;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new BulkLifecycleError(0, null, "The bulk operation timed out. Check each agent's status in the registry before retrying.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** AC: "Bulk operations call POST /api/v1/agents/bulk-lifecycle and display a results summary." Invalidates the registry query on settle (not just success) so any partial successes reflect immediately even if the overall promise still resolves — BulkLifecycleService's own 200 response always carries per-agent success/failure, never a top-level failure for partial results. */
export function useBulkLifecycleMutation() {
  const token = useAppStore((s) => s.auth.token);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: BulkLifecycleVariables) => bulkTransitionLifecycle(token, variables),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-registry"] });
    },
  });
}
