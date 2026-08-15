"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AgentExecutionTrace, AgentHealthHistoryResult, LifecycleHistoryEntry, TimeRange, TraceStatus } from "@/types/dashboard";

async function authedFetch<T>(token: string | null, path: string): Promise<T> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) throw new Error(`Request to ${path} failed (${response.status})`);
  return response.json() as Promise<T>;
}

export function useAgentHealthHistoryQuery(agentId: string, range: TimeRange) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["agent-health-history", token, agentId, range],
    queryFn: () => authedFetch<AgentHealthHistoryResult>(token, `/api/v1/agents/${agentId}/health/history?range=${range}`),
    enabled: Boolean(agentId),
  });
}

export function useAgentTracesQuery(agentId: string, status?: TraceStatus) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["agent-traces", token, agentId, status],
    queryFn: () => authedFetch<{ rows: AgentExecutionTrace[]; total: number }>(token, `/api/v1/agents/${agentId}/traces${status ? `?status=${status}` : ""}`),
    enabled: Boolean(agentId),
  });
}

export function useAgentLifecycleHistoryQuery(agentId: string) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["agent-lifecycle-history", token, agentId],
    queryFn: () => authedFetch<LifecycleHistoryEntry[]>(token, `/api/v1/agents/${agentId}/lifecycle-history`),
    enabled: Boolean(agentId),
  });
}
