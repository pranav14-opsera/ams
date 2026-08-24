"use client";

import { useMutation } from "@tanstack/react-query";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import type { SsoConfigResponse, SsoProtocol, SsoTestResult } from "@/types/onboarding";

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface ConfigureSsoInput {
  tenantId: string;
  protocol: SsoProtocol;
  samlMetadataUrl?: string;
  samlEntityId?: string;
  oidcDiscoveryUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
}

async function configureSso(token: string | null, input: ConfigureSsoInput): Promise<SsoConfigResponse> {
  const { tenantId, ...body } = input;
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants/${tenantId}/auth/sso/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(errBody.message ?? `Failed to save SSO configuration (${response.status})`);
  }
  return response.json() as Promise<SsoConfigResponse>;
}

/** Step 2's own save — the same POST /api/v1/tenants/:tenantId/auth/sso/configure route SsoConfigController already exposes. */
export function useConfigureSsoMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({ mutationFn: (input: ConfigureSsoInput) => configureSso(token, input) });
}

async function testSsoConnection(token: string | null, tenantId: string): Promise<SsoTestResult> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants/${tenantId}/auth/sso/test`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(errBody.message ?? `SSO test connection failed (${response.status})`);
  }
  return response.json() as Promise<SsoTestResult>;
}

/** "Test SSO Connection" button — POST /api/v1/tenants/:tenantId/auth/sso/test, real network+library validation, not a live IdP round-trip (see this WO's reconciliation doc). */
export function useTestSsoConnectionMutation() {
  const token = useAppStore((s) => s.auth.token);
  return useMutation({ mutationFn: (tenantId: string) => testSsoConnection(token, tenantId) });
}
