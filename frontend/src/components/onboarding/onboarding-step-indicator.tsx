import { cn } from "@/lib/utils";
import { SKIPPABLE_STEPS, type OnboardingWizardStep } from "./onboarding-wizard-state";

const STEP_LABELS: Record<OnboardingWizardStep, string> = {
  1: "Organization Setup",
  2: "SSO Configuration",
  3: "SCIM Provisioning",
  4: "First Agent",
  5: "Team & RBAC",
  6: "Verification & Go-Live",
};

export interface OnboardingStepIndicatorProps {
  currentStep: OnboardingWizardStep;
  completedSteps: number[];
  skippedSteps: number[];
}

/** AC 1: "6-step guided flow with progress indicator." Optional steps (3 and 4) are labeled "(optional)" so the customer knows they can skip before reaching them. */
export function OnboardingStepIndicator({ currentStep, completedSteps, skippedSteps }: OnboardingStepIndicatorProps) {
  return (
    <ol aria-label="Onboarding wizard progress" className="flex flex-wrap items-center gap-2">
      {([1, 2, 3, 4, 5, 6] as const).map((step, index) => {
        const isCurrent = step === currentStep;
        const isComplete = completedSteps.includes(step);
        const isSkipped = skippedSteps.includes(step);
        return (
          <li key={step} className="flex items-center gap-2">
            <div className="flex items-center gap-2" aria-current={isCurrent ? "step" : undefined}>
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  isCurrent ? "bg-primary text-primary-foreground" : isComplete || isSkipped ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
                )}
              >
                {step}
              </span>
              <span className={cn("text-sm", isCurrent ? "font-medium" : "text-muted-foreground")}>
                {STEP_LABELS[step]}
                {SKIPPABLE_STEPS.includes(step) && <span className="text-muted-foreground"> (optional)</span>}
                {isSkipped && <span className="text-muted-foreground"> — skipped</span>}
              </span>
            </div>
            {index < 5 && <span aria-hidden="true" className="bg-border h-px w-6" />}
          </li>
        );
      })}
    </ol>
  );
}
