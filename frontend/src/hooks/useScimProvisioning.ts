"use client";

import { useMutation } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { ScimTestResult, ScimTokenResponse } from "@/types/onboarding";

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function generateScimToken(token: string | null, tenantId: string): Promise<ScimTokenResponse> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants/${tenantId}/scim/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ description: "Onboarding wizard" }),
  });
  if (!response.ok) throw new Error(`Failed to generate a SCIM token (${response.status})`);
  return response.json() as Promise<ScimTokenResponse>;
}

/** Step 3: generates the SCIM bearer token shown to the customer (with copy-to-clipboard) exactly once — the raw value is never retrievable again. */
export function useGenerateScimTokenMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({ mutationFn: (tenantId: string) => generateScimToken(token, tenantId) });
}

async function testScimProvisioning(token: string | null, tenantId: string): Promise<ScimTestResult> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants/${tenantId}/scim/test`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(errBody.message ?? `SCIM test provisioning failed (${response.status})`);
  }
  return response.json() as Promise<ScimTestResult>;
}

/** "Test Provisioning" button — POST /api/v1/tenants/:tenantId/scim/test. */
export function useTestScimProvisioningMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({ mutationFn: (tenantId: string) => testScimProvisioning(token, tenantId) });
}
