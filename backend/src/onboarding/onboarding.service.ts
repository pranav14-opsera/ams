import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { OnboardingProgressRepository, type OnboardingProgress } from "./onboarding-progress.repository";

/** Keys inside `stepData` that must never reach the database in plaintext — replaced with a `"__redacted__"` presence marker before persisting. The secret itself already has its own durable, encrypted home (tenant_sso_configs.oidc_client_secret_*, scim_tokens.token_hash) by the time the relevant step actually completes; wizard-progress only needs to remember THAT a value was entered, not what it was, to redraw the form correctly on resume. */
const SENSITIVE_STEP_DATA_KEYS = ["oidcClientSecret", "scimBearerToken"];
const REDACTED_MARKER = "__redacted__";

export interface OnboardingStatusCheck {
  name: string;
  status: "pass" | "fail" | "pending";
  message: string;
}

export interface OnboardingStatus {
  checks: OnboardingStatusCheck[];
  allPassed: boolean;
}

export type ProgressResult = { expired: false; progress: OnboardingProgress } | { expired: true; expiresAt: Date };

function redactStepData(stepData: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [stepKey, value] of Object.entries(stepData)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const sensitiveKey of SENSITIVE_STEP_DATA_KEYS) {
        if (sensitiveKey in inner && inner[sensitiveKey]) {
          inner[sensitiveKey] = REDACTED_MARKER;
        }
      }
      redacted[stepKey] = inner;
    } else {
      redacted[stepKey] = value;
    }
  }
  return redacted;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly repository: OnboardingProgressRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async saveProgress(
    client: Pool | PoolClient,
    tenantId: string,
    actorId: string | null,
    currentStep: number,
    stepData: Record<string, unknown>,
    completedSteps: number[],
  ): Promise<OnboardingProgress> {
    const safeStepData = redactStepData(stepData);
    const progress = await this.repository.upsert(client, tenantId, actorId, currentStep, safeStepData, completedSteps);

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "onboarding.progress_saved",
      resourceType: "onboarding_progress",
      resourceId: tenantId,
      details: { currentStep, completedSteps },
    });

    return progress;
  }

  /** edge_case: "if the customer does not complete onboarding within 7 days, display a message that the onboarding session has expired." Returns `{ expired: true }` (not a thrown error) so the caller can render that message instead of a generic failure. */
  async getProgress(client: Pool | PoolClient, tenantId: string): Promise<ProgressResult | null> {
    const progress = await this.repository.findByTenantId(client, tenantId);
    if (!progress) return null;
    if (progress.expiresAt.getTime() < Date.now()) {
      return { expired: true, expiresAt: progress.expiresAt };
    }
    return { expired: false, progress };
  }

  async restart(client: Pool | PoolClient, tenantId: string): Promise<void> {
    await this.repository.deleteByTenantId(client, tenantId);
  }

  /**
   * AC 8 / Step 6: automated go-live readiness checks. Each check is a
   * real query against the data the earlier steps actually wrote — there
   * is no live external round-trip here (no real IdP to log in against,
   * no live telemetry stream to sample in this sandbox), so this is
   * honestly a STRUCTURAL check ("did the earlier step's own write
   * happen and look coherent"), not a live end-to-end verification. That
   * distinction is documented in this WO's reconciliation doc.
   */
  async getStatus(client: Pool | PoolClient, tenantId: string): Promise<OnboardingStatus> {
    const [ssoCheck, agentCheck, rbacCheck, creditCheck] = await Promise.all([
      this.checkSso(client, tenantId),
      this.checkAgentTelemetry(client, tenantId),
      this.checkRbacPolicies(client, tenantId),
      this.checkCreditBudget(client, tenantId),
    ]);

    const checks = [ssoCheck, agentCheck, rbacCheck, creditCheck];
    return { checks, allPassed: checks.every((c) => c.status === "pass") };
  }

  private async checkSso(client: Pool | PoolClient, tenantId: string): Promise<OnboardingStatusCheck> {
    const result = await client.query<{ protocol: "saml" | "oidc"; saml_cert_pem: string | null; oidc_client_id: string | null }>(
      "SELECT protocol, saml_cert_pem, oidc_client_id FROM tenant_sso_configs WHERE tenant_id = $1",
      [tenantId],
    );
    const config = result.rows[0];
    if (!config) {
      return { name: "sso_login", status: "fail", message: "No SSO configuration has been saved for this tenant yet." };
    }
    const ready = config.protocol === "saml" ? Boolean(config.saml_cert_pem) : Boolean(config.oidc_client_id);
    return ready
      ? { name: "sso_login", status: "pass", message: `${config.protocol.toUpperCase()} configuration is structurally valid.` }
      : { name: "sso_login", status: "fail", message: `${config.protocol.toUpperCase()} configuration is incomplete — re-run "Test SSO Connection" in Step 2.` };
  }

  private async checkAgentTelemetry(client: Pool | PoolClient, tenantId: string): Promise<OnboardingStatusCheck> {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agents WHERE tenant_id = $1 AND lifecycle_status = 'active'",
      [tenantId],
    );
    const count = Number(result.rows[0]?.count ?? "0");
    return count > 0
      ? { name: "agent_telemetry", status: "pass", message: "At least one registered agent is Active." }
      : { name: "agent_telemetry", status: "fail", message: "No agent has reached Active status yet — register or wait for connection validation to complete." };
  }

  private async checkRbacPolicies(client: Pool | PoolClient, tenantId: string): Promise<OnboardingStatusCheck> {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM group_role_mappings WHERE tenant_id = $1",
      [tenantId],
    );
    const count = Number(result.rows[0]?.count ?? "0");
    return count > 0
      ? { name: "rbac_policies", status: "pass", message: `${count} IdP group-to-role mapping(s) applied.` }
      : { name: "rbac_policies", status: "fail", message: "No group-to-role mappings have been configured yet — return to Step 2." };
  }

  private async checkCreditBudget(client: Pool | PoolClient, tenantId: string): Promise<OnboardingStatusCheck> {
    const now = new Date();
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM credit_budgets
       WHERE tenant_id = $1 AND effective_month = $2 AND effective_year = $3`,
      [tenantId, now.getUTCMonth() + 1, now.getUTCFullYear()],
    );
    const count = Number(result.rows[0]?.count ?? "0");
    return count > 0
      ? { name: "credit_budget", status: "pass", message: "A credit budget is allocated for the current period." }
      : { name: "credit_budget", status: "fail", message: "No credit budget has been allocated yet — return to Step 5." };
  }
}
