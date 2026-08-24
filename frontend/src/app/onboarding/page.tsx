"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { OnboardingStepIndicator } from "@/components/onboarding/onboarding-step-indicator";
import { StepOrganizationSetup } from "@/components/onboarding/step-organization-setup";
import { StepSsoConfiguration } from "@/components/onboarding/step-sso-configuration";
import { StepScimProvisioning } from "@/components/onboarding/step-scim-provisioning";
import { StepFirstAgent } from "@/components/onboarding/step-first-agent";
import { StepTeamRbac } from "@/components/onboarding/step-team-rbac";
import { StepVerification } from "@/components/onboarding/step-verification";
import { useOnboardingWizardState } from "@/components/onboarding/onboarding-wizard-state";
import { useOnboardingProgressQuery, useRestartOnboardingMutation, useSaveOnboardingProgressMutation } from "@/hooks/useOnboardingProgress";
import { useUnsavedChangesWarning } from "@/hooks/useUnsavedChangesWarning";
import { useAppStore } from "@/stores/app-store";
import type { SsoConfigResponse } from "@/types/onboarding";

const AUTOSAVE_INTERVAL_MS = 60_000;

/**
 * WO-082: the 6-step self-service onboarding wizard. Step 1 (Organization
 * Setup) is reachable with no session at all — POST /api/v1/tenants is
 * `@NoPermissionRequired()` (a brand-new tenant has no users/roles yet).
 * Every step after that (SSO/SCIM configuration, group mappings, team
 * creation, credit allocation) calls routes gated by a real platform JWT
 * scoped to the just-created tenant. This codebase has no
 * "auto-issue a session immediately after tenant provisioning" flow yet
 * (see this WO's reconciliation doc) — the honest, documented assumption
 * here is that the caller already holds (or next obtains, e.g. via an
 * out-of-scope invite-acceptance flow) a valid session for that tenant
 * before continuing past Step 1. A clear banner communicates this rather
 * than the wizard silently failing on Step 2.
 */
export default function OnboardingPage() {
  const token = useAppStore((s) => s.auth.token);
  // A RETURNING customer admin resuming onboarding has already been
  // through Step 1 in an earlier session — their own JWT already carries
  // their tenant id, which is exactly what GET .../progress needs to key
  // by. A brand-new visitor with no session yet has no authTenantId, so
  // this falls back to whatever Step 1 itself just provisioned in THIS
  // session (state.tenant) — either way, this is the one place that
  // decides "which tenant's onboarding are we even looking at."
  const authTenantId = useAppStore((s) => s.auth.tenantId);
  const [state, dispatch] = useOnboardingWizardState();
  const [ssoConfig, setSsoConfig] = useState<SsoConfigResponse | null>(null);
  const [hasRestored, setHasRestored] = useState(false);

  const effectiveTenantId = state.tenant?.id ?? authTenantId;
  const progressQuery = useOnboardingProgressQuery(effectiveTenantId);
  const saveProgress = useSaveOnboardingProgressMutation();
  const restartOnboarding = useRestartOnboardingMutation();

  useUnsavedChangesWarning(state.isDirty && state.step < 6);

  // implementation_steps: "restore state on page load with a 'Welcome
  // back — resuming from Step N' message."
  useEffect(() => {
    if (hasRestored || !progressQuery.isSuccess || !progressQuery.data) return;
    setHasRestored(true);
    if (progressQuery.data.expired) {
      dispatch({ type: "MARK_EXPIRED", expired: true });
      return;
    }
    dispatch({ type: "RESTORE", currentStep: progressQuery.data.currentStep, completedSteps: progressQuery.data.completedSteps, stepData: progressQuery.data.stepData });
    // Step 1's own provisioning result isn't re-fetched on resume (there
    // is no GET /api/v1/tenants/:id/summary this page calls) — enough of
    // it to render Steps 2+ is reconstructed from what Step 1 itself
    // already persisted into stepData.step1, plus the tenant id the JWT
    // already told us.
    const step1 = (progressQuery.data.stepData as { step1?: { organizationName: string; dataResidencyRegion: "us" | "eu" } }).step1;
    if (!state.tenant && authTenantId && step1) {
      dispatch({ type: "SET_TENANT", tenant: { id: authTenantId, name: step1.organizationName, slug: "", dataResidencyRegion: step1.dataResidencyRegion } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs exactly once per successful progress fetch (guarded by hasRestored above); re-reading state.tenant/authTenantId here would re-trigger on every subsequent render.
  }, [hasRestored, progressQuery.isSuccess, progressQuery.data, dispatch]);

  // implementation_steps: "auto-save wizard progress... on each step
  // completion and on a 60-second interval during active editing."
  useEffect(() => {
    if (!effectiveTenantId || state.isExpired) return;
    const interval = setInterval(() => {
      saveProgress.mutate({ tenantId: effectiveTenantId, currentStep: state.step, stepData: state.stepData, completedSteps: state.completedSteps });
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm the interval on tenant/expiry changes only; the mutation itself always reads the latest closure-captured state at fire time.
  }, [effectiveTenantId, state.isExpired]);

  function persistStep(step: number, completedSteps: number[]) {
    if (!effectiveTenantId) return;
    saveProgress.mutate({ tenantId: effectiveTenantId, currentStep: step, stepData: state.stepData, completedSteps });
  }

  const resumeMessage = useMemo(() => {
    if (!state.resumedFromStep || state.resumedFromStep === 1) return null;
    return `Welcome back — resuming from Step ${state.resumedFromStep}.`;
  }, [state.resumedFromStep]);

  if (state.isExpired) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Onboarding session expired</h1>
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Your onboarding session has expired after 7 days of inactivity. You can restart onboarding, or contact support if you need help.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => {
              if (effectiveTenantId) restartOnboarding.mutate(effectiveTenantId);
              dispatch({ type: "RESET" });
              setHasRestored(false);
            }}
          >
            Restart Onboarding
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Welcome to Agent Management Service</h1>
        <p className="text-muted-foreground text-sm">Complete these steps to get your organization fully set up.</p>
      </div>

      {resumeMessage && (
        <p role="status" className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          {resumeMessage}
        </p>
      )}

      {saveProgress.isError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Progress could not be saved — please do not close this page.
        </p>
      )}

      <OnboardingStepIndicator currentStep={state.step} completedSteps={state.completedSteps} skippedSteps={state.skippedSteps} />

      {state.step > 1 && !token && (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Sign in as this organization&apos;s admin to continue — the remaining steps require an authenticated session for your new tenant.
        </p>
      )}

      {state.step === 1 && (
        <StepOrganizationSetup
          tenant={state.tenant}
          onProvisioned={(tenant) => {
            dispatch({ type: "SET_TENANT", tenant });
            dispatch({ type: "MARK_COMPLETED", step: 1 });
            dispatch({ type: "NEXT_STEP" });
          }}
        />
      )}

      {state.step === 2 && effectiveTenantId && (
        <div className="flex flex-col gap-4">
          <StepSsoConfiguration tenantId={effectiveTenantId} config={ssoConfig} onConfigured={(config) => setSsoConfig(config)} />
          <div className="flex justify-end border-t pt-4">
            <Button
              type="button"
              disabled={!ssoConfig}
              onClick={() => {
                dispatch({ type: "SET_STEP_DATA", step: "step2", data: { protocol: ssoConfig!.protocol } });
                dispatch({ type: "MARK_COMPLETED", step: 2 });
                persistStep(3, [...state.completedSteps, 2]);
                dispatch({ type: "NEXT_STEP" });
              }}
            >
              Continue to SCIM Provisioning
            </Button>
          </div>
        </div>
      )}

      {state.step === 3 && effectiveTenantId && (
        <StepScimProvisioning
          tenantId={effectiveTenantId}
          onSkip={() => {
            dispatch({ type: "SET_STEP_DATA", step: "step3", data: { skipped: true, scimConfigured: false } });
            persistStep(4, state.completedSteps);
            dispatch({ type: "SKIP_STEP" });
          }}
          onConfigured={() => {
            dispatch({ type: "SET_STEP_DATA", step: "step3", data: { skipped: false, scimConfigured: true } });
            dispatch({ type: "MARK_COMPLETED", step: 3 });
            persistStep(4, [...state.completedSteps, 3]);
            dispatch({ type: "NEXT_STEP" });
          }}
        />
      )}

      {state.step === 4 && (
        <StepFirstAgent
          onSkip={() => {
            dispatch({ type: "SET_STEP_DATA", step: "step4", data: { skipped: true } });
            persistStep(5, state.completedSteps);
            dispatch({ type: "SKIP_STEP" });
          }}
          onAgentRegistered={(agentId) => {
            dispatch({ type: "SET_STEP_DATA", step: "step4", data: { skipped: false, agentId } });
            dispatch({ type: "MARK_COMPLETED", step: 4 });
            persistStep(5, [...state.completedSteps, 4]);
            dispatch({ type: "NEXT_STEP" });
          }}
        />
      )}

      {state.step === 5 && (
        <StepTeamRbac
          agentId={state.stepData.step4?.agentId ?? null}
          onComplete={(teamId) => {
            dispatch({ type: "SET_STEP_DATA", step: "step5", data: { teamId } });
            dispatch({ type: "MARK_COMPLETED", step: 5 });
            persistStep(6, [...state.completedSteps, 5]);
            dispatch({ type: "NEXT_STEP" });
          }}
        />
      )}

      {state.step === 6 && effectiveTenantId && (
        <StepVerification
          tenantId={effectiveTenantId}
          onComplete={() => {
            dispatch({ type: "MARK_COMPLETED", step: 6 });
            persistStep(6, [...state.completedSteps, 6]);
          }}
        />
      )}
    </div>
  );
}
