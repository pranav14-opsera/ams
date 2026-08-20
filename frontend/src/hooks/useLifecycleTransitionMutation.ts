"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AgentLifecycleStatus, ApiErrorBody, LifecycleTransitionResponse } from "@/types/dashboard";

export class LifecycleTransitionError extends Error {
  status: number;
  body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, message: string) {
    super(message);
    this.name = "LifecycleTransitionError";
    this.status = status;
    this.body = body;
  }
}

export interface LifecycleTransitionVariables {
  agentId: string;
  targetStatus: AgentLifecycleStatus;
  justification?: string;
}

// edge_case: "Network failure during lifecycle transition... implement a
// 15-second client-side timeout" — this WO's own constraint (individual
// transitions "must complete within 10 seconds"), so a 15s abort gives the
// server's own budget a small margin before the client gives up.
export const LIFECYCLE_TRANSITION_TIMEOUT_MS = 15_000;

async function transitionLifecycle(token: string | null, { agentId, targetStatus, justification }: LifecycleTransitionVariables): Promise<LifecycleTransitionResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIFECYCLE_TRANSITION_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/${agentId}/lifecycle`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ targetStatus, justification }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new LifecycleTransitionError(response.status, body, body?.message ?? `Failed to transition agent (${response.status}).`);
    }

    return response.json() as Promise<LifecycleTransitionResponse>;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LifecycleTransitionError(0, null, "The request timed out. Check the agent's status in the registry before retrying.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * AC: "Confirming the action calls PATCH /api/v1/agents/{id}/lifecycle and
 * the agent status updates in the table within 10 seconds." On success the
 * agent-registry query is invalidated so the table refetches the
 * authoritative server state (in addition to the real-time /ws/health push
 * useAgentHealthSocket already picks up independently).
 */
export function useLifecycleTransitionMutation() {
  const token = useAppStore((s) => s.auth.token);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: LifecycleTransitionVariables) => transitionLifecycle(token, variables),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-registry"] });
    },
  });
}
