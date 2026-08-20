import { cn } from "@/lib/utils";
import type { WizardStep } from "./wizard-state";

const STEP_LABELS: Record<WizardStep, string> = {
  1: "Select Framework",
  2: "Configure Connection",
  3: "Assign Team",
  4: "Validate & Confirm",
};

export interface StepIndicatorProps {
  currentStep: WizardStep;
}

/** AC 1: "a clear multi-step flow with a progress indicator showing" the four named steps. */
export function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <ol aria-label="Register agent wizard progress" className="flex items-center gap-2">
      {([1, 2, 3, 4] as const).map((step, index) => {
        const isCurrent = step === currentStep;
        const isComplete = step < currentStep;
        return (
          <li key={step} className="flex items-center gap-2">
            <div className="flex items-center gap-2" aria-current={isCurrent ? "step" : undefined}>
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  isCurrent ? "bg-primary text-primary-foreground" : isComplete ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
                )}
              >
                {step}
              </span>
              <span className={cn("text-sm", isCurrent ? "font-medium" : "text-muted-foreground")}>{STEP_LABELS[step]}</span>
            </div>
            {index < 3 && <span aria-hidden="true" className="bg-border h-px w-6" />}
          </li>
        );
      })}
    </ol>
  );
}
