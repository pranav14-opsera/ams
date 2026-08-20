"use client";

import { useMutation } from "@tanstack/react-query";
import { env } from "@/env";
import type { Tenant } from "@/types/onboarding";

export class CreateTenantError extends Error {
  status: number;
  body: { message?: string } | null;

  constructor(status: number, body: { message?: string } | null, message: string) {
    super(message);
    this.name = "CreateTenantError";
    this.status = status;
    this.body = body;
  }
}

export interface CreateTenantRequest {
  name: string;
  slug: string;
  dataResidencyRegion: "us" | "eu";
}

/** Step 1 (Organization Setup) — POST /api/v1/tenants, the existing WO-013 route (NoPermissionRequired: brand-new-tenant creation happens before any of that tenant's users/roles exist). */
async function createTenant(request: CreateTenantRequest): Promise<Tenant> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new CreateTenantError(response.status, body, body?.message ?? `Failed to provision organization (${response.status})`);
  }
  const data = (await response.json()) as { tenantId: string; name: string; region: string };
  return { id: data.tenantId, name: data.name, slug: request.slug, dataResidencyRegion: data.region as "us" | "eu" };
}

export function useCreateTenantMutation() {
  return useMutation({ mutationFn: createTenant });
}
