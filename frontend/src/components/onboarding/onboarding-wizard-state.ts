import { useReducer } from "react";
import type { OnboardingStepData, Tenant } from "@/types/onboarding";

export const ONBOARDING_STEPS = [1, 2, 3, 4, 5, 6] as const;
export type OnboardingWizardStep = (typeof ONBOARDING_STEPS)[number];

/** Step 3 (SCIM) and Step 4 (First Agent) are the two AC-designated optional/skippable steps. */
export const SKIPPABLE_STEPS: OnboardingWizardStep[] = [3, 4];

export interface OnboardingWizardState {
  step: OnboardingWizardStep;
  tenant: Tenant | null;
  completedSteps: number[];
  skippedSteps: number[];
  stepData: OnboardingStepData;
  isDirty: boolean;
  /** Set once server-side progress has been restored on page load — drives the "Welcome back" banner. */
  resumedFromStep: number | null;
  isExpired: boolean;
}

export type OnboardingWizardAction =
  | { type: "SET_TENANT"; tenant: Tenant }
  | { type: "SET_STEP_DATA"; step: keyof OnboardingStepData; data: OnboardingStepData[keyof OnboardingStepData] }
  | { type: "NEXT_STEP" }
  | { type: "PREVIOUS_STEP" }
  | { type: "GO_TO_STEP"; step: OnboardingWizardStep }
  | { type: "SKIP_STEP" }
  | { type: "MARK_COMPLETED"; step: number }
  | { type: "RESTORE"; currentStep: number; completedSteps: number[]; stepData: OnboardingStepData }
  | { type: "MARK_EXPIRED"; expired: boolean }
  | { type: "RESET" };

export const INITIAL_ONBOARDING_STATE: OnboardingWizardState = {
  step: 1,
  tenant: null,
  completedSteps: [],
  skippedSteps: [],
  stepData: {},
  isDirty: false,
  resumedFromStep: null,
  isExpired: false,
};

function clampStep(step: number): OnboardingWizardStep {
  return Math.min(Math.max(step, 1), 6) as OnboardingWizardStep;
}

export function onboardingWizardReducer(state: OnboardingWizardState, action: OnboardingWizardAction): OnboardingWizardState {
  switch (action.type) {
    case "SET_TENANT":
      return { ...state, tenant: action.tenant, isDirty: true };
    case "SET_STEP_DATA":
      return { ...state, stepData: { ...state.stepData, [action.step]: action.data }, isDirty: true };
    case "NEXT_STEP":
      return { ...state, step: clampStep(state.step + 1) };
    case "PREVIOUS_STEP":
      // AC (edge_case): data residency (Step 1) is locked once the tenant is provisioned — going back to Step 1 after that point is not offered by the wizard shell (StepOrganizationSetup itself renders read-only once state.tenant is set), so PREVIOUS_STEP is safe to allow unconditionally here.
      return { ...state, step: clampStep(state.step - 1) };
    case "GO_TO_STEP":
      return { ...state, step: action.step };
    case "SKIP_STEP":
      if (!SKIPPABLE_STEPS.includes(state.step)) return state;
      return { ...state, skippedSteps: [...new Set([...state.skippedSteps, state.step])], step: clampStep(state.step + 1) };
    case "MARK_COMPLETED":
      return { ...state, completedSteps: [...new Set([...state.completedSteps, action.step])] };
    case "RESTORE":
      return {
        ...state,
        step: clampStep(action.currentStep),
        completedSteps: action.completedSteps,
        stepData: action.stepData,
        resumedFromStep: action.currentStep,
        isDirty: false,
      };
    case "MARK_EXPIRED":
      return { ...state, isExpired: action.expired };
    case "RESET":
      return INITIAL_ONBOARDING_STATE;
    default:
      return state;
  }
}

export function useOnboardingWizardState() {
  return useReducer(onboardingWizardReducer, INITIAL_ONBOARDING_STATE);
}
