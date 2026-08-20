import { describe, expect, it } from "vitest";
import { INITIAL_ONBOARDING_STATE, onboardingWizardReducer } from "./onboarding-wizard-state";

const tenant = { id: "t1", name: "Acme Health", slug: "acme-health", dataResidencyRegion: "us" as const };

describe("onboarding wizard reducer", () => {
  it("advances through steps and marks them completed", () => {
    let state = onboardingWizardReducer(INITIAL_ONBOARDING_STATE, { type: "SET_TENANT", tenant });
    state = onboardingWizardReducer(state, { type: "MARK_COMPLETED", step: 1 });
    state = onboardingWizardReducer(state, { type: "NEXT_STEP" });
    expect(state.step).toBe(2);
    expect(state.completedSteps).toEqual([1]);
  });

  it("SKIP_STEP is a no-op on a non-skippable step (e.g. Step 1 or Step 2)", () => {
    const state = onboardingWizardReducer({ ...INITIAL_ONBOARDING_STATE, step: 2 }, { type: "SKIP_STEP" });
    expect(state.step).toBe(2);
    expect(state.skippedSteps).toEqual([]);
  });

  it("SKIP_STEP on Step 3 (SCIM) records it skipped and advances to Step 4", () => {
    const state = onboardingWizardReducer({ ...INITIAL_ONBOARDING_STATE, step: 3 }, { type: "SKIP_STEP" });
    expect(state.step).toBe(4);
    expect(state.skippedSteps).toEqual([3]);
  });

  it("SKIP_STEP on Step 4 (First Agent) records it skipped and advances to Step 5", () => {
    const state = onboardingWizardReducer({ ...INITIAL_ONBOARDING_STATE, step: 4 }, { type: "SKIP_STEP" });
    expect(state.step).toBe(5);
    expect(state.skippedSteps).toEqual([4]);
  });

  it("does not skip the same step twice into skippedSteps", () => {
    let state = onboardingWizardReducer({ ...INITIAL_ONBOARDING_STATE, step: 3 }, { type: "SKIP_STEP" });
    state = onboardingWizardReducer({ ...state, step: 3 }, { type: "SKIP_STEP" });
    expect(state.skippedSteps).toEqual([3]);
  });

  it("clamps NEXT_STEP/PREVIOUS_STEP at the 1..6 bounds", () => {
    const past6 = onboardingWizardReducer({ ...INITIAL_ONBOARDING_STATE, step: 6 }, { type: "NEXT_STEP" });
    expect(past6.step).toBe(6);
    const before1 = onboardingWizardReducer({ ...INITIAL_ONBOARDING_STATE, step: 1 }, { type: "PREVIOUS_STEP" });
    expect(before1.step).toBe(1);
  });

  it("RESTORE deserializes server-persisted progress back into wizard state (server-side persistence round-trip)", () => {
    const state = onboardingWizardReducer(INITIAL_ONBOARDING_STATE, {
      type: "RESTORE",
      currentStep: 4,
      completedSteps: [1, 2],
      stepData: { step1: { organizationName: "Acme Health", dataResidencyRegion: "us", adminEmail: "admin@acme.test" } },
    });
    expect(state.step).toBe(4);
    expect(state.completedSteps).toEqual([1, 2]);
    expect(state.stepData.step1?.organizationName).toBe("Acme Health");
    expect(state.resumedFromStep).toBe(4);
    expect(state.isDirty).toBe(false);
  });

  it("MARK_EXPIRED flips the expired flag for the session-expiration edge case", () => {
    const state = onboardingWizardReducer(INITIAL_ONBOARDING_STATE, { type: "MARK_EXPIRED", expired: true });
    expect(state.isExpired).toBe(true);
  });

  it("SET_STEP_DATA merges data under the given step key without clobbering other steps", () => {
    let state = onboardingWizardReducer(INITIAL_ONBOARDING_STATE, {
      type: "SET_STEP_DATA",
      step: "step1",
      data: { organizationName: "Acme Health", dataResidencyRegion: "us", adminEmail: "a@b.com" },
    });
    state = onboardingWizardReducer(state, { type: "SET_STEP_DATA", step: "step2", data: { protocol: "oidc" } });
    expect(state.stepData.step1?.organizationName).toBe("Acme Health");
    expect(state.stepData.step2?.protocol).toBe("oidc");
  });
});
