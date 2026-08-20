"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { AgentRegistryFilters, AgentRegistryPageSize, AgentRegistryResult, AgentRegistrySort } from "@/types/dashboard";

function buildQueryString(filters: AgentRegistryFilters, sort: AgentRegistrySort, page: number, pageSize: AgentRegistryPageSize): string {
  const params = new URLSearchParams();
  if (filters.framework && filters.framework.length > 0) params.set("framework", filters.framework.join(","));
  // Wire param name is "lifecycleStatus" (matches AgentsController's existing,
  // already-tested ListAgentsQueryDto field) — not "status" as this WO's own
  // literal api_contracts names it, to avoid a breaking rename of an
  // existing, tested query param for a brand-new consumer of this endpoint.
  if (filters.status && filters.status.length > 0) params.set("lifecycleStatus", filters.status.join(","));
  if (filters.teamId) params.set("teamId", filters.teamId);
  params.set("sortBy", sort.sortBy === "status" ? "lifecycleStatus" : sort.sortBy);
  params.set("sortOrder", sort.sortOrder);
  // The REST endpoint itself is limit/offset-based (AgentsRepository's own
  // pagination) — page/pageSize is this table's own UI-level vocabulary,
  // translated here rather than pushed into the backend as a second
  // pagination scheme.
  params.set("limit", String(pageSize));
  params.set("offset", String((page - 1) * pageSize));
  return `?${params.toString()}`;
}

async function fetchAgentRegistry(
  token: string | null,
  filters: AgentRegistryFilters,
  sort: AgentRegistrySort,
  page: number,
  pageSize: AgentRegistryPageSize,
): Promise<AgentRegistryResult> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents${buildQueryString(filters, sort, page, pageSize)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const error = new Error(`Failed to load agent registry (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<AgentRegistryResult>;
}

/**
 * AC: server-side sorting, filtering, and pagination for the Agent
 * Registry table — every one of those state changes is a fresh fetch of
 * GET /api/v1/agents with the corresponding query params (audit-logged
 * server-side by AgentsService.findAll's own "agent_registry.viewed" event,
 * one per call this hook makes).
 */
export function useAgentRegistryQuery(filters: AgentRegistryFilters, sort: AgentRegistrySort, page: number, pageSize: AgentRegistryPageSize) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["agent-registry", token, filters, sort, page, pageSize],
    queryFn: () => fetchAgentRegistry(token, filters, sort, page, pageSize),
  });
}
