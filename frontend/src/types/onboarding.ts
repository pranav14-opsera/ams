/** Mirrors backend/src/tenants/dto/create-tenant.dto.ts and TenantsController's response shape. */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  dataResidencyRegion: "us" | "eu";
}

export type SsoProtocol = "saml" | "oidc";

export const PLATFORM_ROLES = [
  { value: "platform_admin", label: "Platform Administrator" },
  { value: "team_lead", label: "Team Lead" },
  { value: "agent_operator", label: "Agent Operator" },
  { value: "finance_manager", label: "Finance Manager" },
  { value: "compliance_officer", label: "Compliance Officer" },
] as const;
export type PlatformRoleValue = (typeof PLATFORM_ROLES)[number]["value"];

export interface GroupRoleMapping {
  id: string;
  idpGroup: string;
  platformRole: PlatformRoleValue;
  priority: number;
}

export interface SsoConfigResponse {
  id: string;
  protocol: SsoProtocol;
  samlMetadataUrl: string | null;
  samlEntityId: string | null;
  samlCertPem?: string;
  oidcDiscoveryUrl: string | null;
  oidcClientId: string | null;
  acsUrl?: string;
  entityId?: string;
  redirectUri?: string;
}

export interface SsoTestResult {
  success: boolean;
  diagnostics: {
    metadataFetch: "pass" | "fail";
    certificateValidation: "pass" | "fail";
    assertionParsing: "pass" | "fail";
    groupMapping: "pass" | "fail";
  };
  errorMessage: string | null;
}

export interface ScimTokenResponse {
  id: string;
  description: string | null;
  createdAt: string;
  token: string;
}

export interface ScimTestResult {
  success: boolean;
  diagnostics: {
    tokenActive: "pass" | "fail";
    filterParsing: "pass" | "fail";
    endpointReachable: "pass" | "fail";
  };
  errorMessage: string | null;
}

export interface OnboardingStatusCheck {
  name: string;
  status: "pass" | "fail" | "pending";
  message: string;
}

export interface OnboardingStatus {
  checks: OnboardingStatusCheck[];
  allPassed: boolean;
}

export type OnboardingProgressResponse =
  | { expired: true; expiresAt: string }
  | { expired: false; currentStep: number; stepData: Record<string, unknown>; completedSteps: number[]; createdAt: string; expiresAt: string };

/** The 6-step wizard's own per-step form data — persisted (with secrets redacted server-side) via POST /api/v1/onboarding/{tenantId}/progress. */
export interface OnboardingStepData {
  step1?: { organizationName: string; dataResidencyRegion: "us" | "eu"; adminEmail: string };
  step2?: {
    protocol: SsoProtocol;
    samlMetadataUrl?: string;
    samlEntityId?: string;
    oidcDiscoveryUrl?: string;
    oidcClientId?: string;
    oidcClientSecret?: string; // redacted to "__redacted__" once persisted server-side
    groupRoleMappings?: { idpGroup: string; platformRole: PlatformRoleValue }[];
  };
  step3?: { skipped: boolean; scimConfigured: boolean };
  step4?: { skipped: boolean; agentId?: string };
  step5?: { teamId?: string; teamName?: string; creditPoolTotal?: number; allocatedCredits?: number };
}
