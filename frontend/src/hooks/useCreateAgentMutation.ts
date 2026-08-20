"use client";

import { useMutation } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { ApiErrorBody, CreateAgentRequest, CreateAgentResponse } from "@/types/dashboard";

export class CreateAgentError extends Error {
  status: number;
  body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, message: string) {
    super(message);
    this.name = "CreateAgentError";
    this.status = status;
    this.body = body;
  }
}

async function createAgent(token: string | null, request: CreateAgentRequest): Promise<CreateAgentResponse> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    // edge_cases: 409 duplicate name / 400 field validation both carry a
    // structured body the wizard's own Step 4 error UI maps back onto the
    // relevant field or a top-level banner — never a raw generic message.
    throw new CreateAgentError(response.status, body, body?.message ?? `Failed to register agent (${response.status})`);
  }

  return response.json() as Promise<CreateAgentResponse>;
}

/** Step 4 (Validate & Confirm)'s own submit — AC 10: "the server returns the created agent with status 'Connecting' within 5 seconds." */
export function useCreateAgentMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({
    mutationFn: (request: CreateAgentRequest) => createAgent(token, request),
  });
}

async function retryValidation(token: string | null, agentId: string): Promise<void> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/${agentId}/retry-validation`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Failed to retry connection validation (${response.status})`);
  }
}

/** edge_case: "Connection validation timeout... 'Retry'... option" — re-runs validation against the already-created agent's own stored config, no re-collection of credentials. */
export function useRetryValidationMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({
    mutationFn: (agentId: string) => retryValidation(token, agentId),
  });
}
