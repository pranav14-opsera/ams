"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { GroupRoleMapping, PlatformRoleValue } from "@/types/onboarding";

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchMappings(token: string | null, tenantId: string): Promise<GroupRoleMapping[]> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants/${tenantId}/group-mappings`, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`Failed to load group mappings (${response.status})`);
  return response.json() as Promise<GroupRoleMapping[]>;
}

/** Step 2's group-to-role mapping interface — GET/POST /api/v1/tenants/:tenantId/group-mappings, the existing WO-023 GroupMappingController. */
export function useGroupMappingsQuery(tenantId: string | null) {
  const token = useAppStore((s) => s.auth.token);
  return useQuery({
    queryKey: ["group-mappings", tenantId],
    queryFn: () => fetchMappings(token, tenantId!),
    enabled: Boolean(tenantId),
  });
}

export interface UpsertMappingInput {
  tenantId: string;
  idpGroup: string;
  platformRole: PlatformRoleValue;
  priority: number;
}

async function upsertMapping(token: string | null, input: UpsertMappingInput): Promise<GroupRoleMapping> {
  const { tenantId, ...body } = input;
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants/${tenantId}/group-mappings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Failed to save group mapping (${response.status})`);
  return response.json() as Promise<GroupRoleMapping>;
}

export function useUpsertGroupMappingMutation() {
  const token = useAppStore((s) => s.auth.token);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertMappingInput) => upsertMapping(token, input),
    onSuccess: (_data, input) => void queryClient.invalidateQueries({ queryKey: ["group-mappings", input.tenantId] }),
  });
}

async function deleteMapping(token: string | null, tenantId: string, id: string): Promise<void> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants/${tenantId}/group-mappings/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok) throw new Error(`Failed to delete group mapping (${response.status})`);
}

export function useDeleteGroupMappingMutation() {
  const token = useAppStore((s) => s.auth.token);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, id }: { tenantId: string; id: string }) => deleteMapping(token, tenantId, id),
    onSuccess: (_data, { tenantId }) => void queryClient.invalidateQueries({ queryKey: ["group-mappings", tenantId] }),
  });
}
