import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StepIndicator } from "./step-indicator";
import type { WizardStep } from "./wizard-state";

export interface MultiStepWizardProps {
  currentStep: WizardStep;
  children: ReactNode;
  onBack: () => void;
  onNext: () => void;
  canGoBack: boolean;
  /** AC: "next button disabled until current step is valid." */
  canGoNext: boolean;
  isLastStep: boolean;
  nextLabel?: string;
  /** Hides the nav bar entirely once Step 4 has reached a terminal outcome — the success/error screen has its own navigation (edge_cases/AC 8/9), not Back/Next. */
  hideNav?: boolean;
}

/**
 * The reusable wizard shell (implementation_steps): step indicator,
 * back/next navigation, and step-validation gating. Deliberately knows
 * nothing about frameworks/schemas/teams/connection validation — every
 * step's own content is passed as `children`, keeping this genuinely
 * reusable for a future multi-step flow elsewhere in the app.
 */
export function MultiStepWizard({ currentStep, children, onBack, onNext, canGoBack, canGoNext, isLastStep, nextLabel, hideNav }: MultiStepWizardProps) {
  return (
    <div className="flex flex-col gap-6">
      <StepIndicator currentStep={currentStep} />
      <div>{children}</div>
      {!hideNav && (
        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <Button type="button" variant="outline" onClick={onBack} disabled={!canGoBack}>
            Back
          </Button>
          <Button type="button" onClick={onNext} disabled={!canGoNext}>
            {nextLabel ?? (isLastStep ? "Submit" : "Next")}
          </Button>
        </div>
      )}
    </div>
  );
}
