"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AgentDetail } from "@/types/dashboard";

export type ConnectionValidationPhase = "idle" | "validating" | "success" | "error" | "timeout";

export interface ConnectionValidationState {
  phase: ConnectionValidationPhase;
  /** AC 7: "Connecting... Validating credentials... Establishing telemetry handshake..." — a staged, cosmetic progress message cycling while the real poll is still pending (the backend's own connectionValidation is a flat pending/success/failed, no sub-stage of its own to report — see ConnectionValidationService's own docstring on the backend). */
  progressMessage: string;
  agent: AgentDetail | null;
  errorMessage: string | null;
}

// AC 7's own literal wording, in order.
const PROGRESS_MESSAGES = ["Connecting…", "Validating credentials…", "Establishing telemetry handshake…"];
const PROGRESS_MESSAGE_INTERVAL_MS = 4_000;
const POLL_INTERVAL_MS = 2_000;
export const CONNECTION_VALIDATION_TIMEOUT_MS = 60_000; // AC/constraints: "must complete within 60 seconds."

async function fetchAgent(token: string | null, agentId: string): Promise<AgentDetail> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/${agentId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const error = new Error(`Failed to load agent (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<AgentDetail>;
}

/**
 * Step 4 (Validate & Confirm)'s own polling loop — starts the moment an
 * agentId is supplied (right after POST /api/v1/agents resolves), polls
 * GET /api/v1/agents/{id} every 2 seconds, and settles into success/error/
 * timeout. `retry()` resets and restarts the whole loop (edge_case:
 * "Connection validation timeout... 'Retry' and 'Save as Draft' options").
 */
export function useConnectionValidationPolling(agentId: string | null) {
  const token = useAppStore((s) => s.auth.token);
  const [state, setState] = useState<ConnectionValidationState>({ phase: "idle", progressMessage: PROGRESS_MESSAGES[0]!, agent: null, errorMessage: null });
  const [generation, setGeneration] = useState(0);

  const retry = useCallback(() => {
    setState({ phase: "idle", progressMessage: PROGRESS_MESSAGES[0]!, agent: null, errorMessage: null });
    setGeneration((g) => g + 1);
  }, []);

  const settledRef = useRef(false);

  useEffect(() => {
    if (!agentId) return;
    settledRef.current = false;
    setState((prev) => ({ ...prev, phase: "validating" }));

    let progressIndex = 0;
    const progressTimer = setInterval(() => {
      progressIndex = Math.min(progressIndex + 1, PROGRESS_MESSAGES.length - 1);
      if (!settledRef.current) setState((prev) => ({ ...prev, progressMessage: PROGRESS_MESSAGES[progressIndex]! }));
    }, PROGRESS_MESSAGE_INTERVAL_MS);

    const startedAt = Date.now();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const agent = await fetchAgent(token, agentId!);
        if (cancelled) return;

        const validationStatus = agent.connectionValidation.status;
        if (validationStatus === "success" || agent.lifecycleStatus === "active") {
          settledRef.current = true;
          setState({ phase: "success", progressMessage: PROGRESS_MESSAGES[PROGRESS_MESSAGES.length - 1]!, agent, errorMessage: null });
          return;
        }
        if (validationStatus === "failed") {
          settledRef.current = true;
          setState((prev) => ({ ...prev, phase: "error", agent, errorMessage: agent.connectionValidation.message ?? "Connection validation failed." }));
          return;
        }
      } catch (err) {
        // A transient network error mid-poll doesn't fail the whole
        // wizard step — edge_case: "Network disconnection during
        // validation" surfaces only once the 60s budget is actually
        // exhausted without ever having reached a terminal outcome.
        if (cancelled) return;
        setState((prev) => ({ ...prev, errorMessage: err instanceof Error ? `Connection lost — please check your network and retry. (${err.message})` : "Connection lost — please check your network and retry." }));
      }

      if (Date.now() - startedAt >= CONNECTION_VALIDATION_TIMEOUT_MS) {
        settledRef.current = true;
        setState((prev) => ({ ...prev, phase: "timeout", errorMessage: "Connection validation timed out after 60 seconds." }));
        return;
      }

      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();

    return () => {
      cancelled = true;
      clearInterval(progressTimer);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [agentId, token, generation]);

  return { ...state, retry };
}
