"use client";

import { Button } from "@/components/ui/button";
import { useOnboardingStatusQuery } from "@/hooks/useOnboardingStatus";

export interface StepVerificationProps {
  tenantId: string;
  onComplete: () => void;
}

const CHECK_LABELS: Record<string, string> = {
  sso_login: "SSO login",
  agent_telemetry: "First agent streaming telemetry",
  rbac_policies: "RBAC policies applied",
  credit_budget: "Credit budget allocated",
};

/**
 * AC 8: verification checklist with automated green/red checks, "Re-run
 * Checks," and "Complete Onboarding" enabled only once every check
 * passes. GET /api/v1/onboarding/{tenantId}/status computes each check
 * from real rows the earlier steps wrote (see OnboardingService's own
 * comment on what's structural vs. a live round-trip in this sandbox).
 */
export function StepVerification({ tenantId, onComplete }: StepVerificationProps) {
  const statusQuery = useOnboardingStatusQuery(tenantId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Verification &amp; Go-Live</h2>
        <p className="text-muted-foreground text-sm">We&apos;re confirming everything is set up correctly before you go live.</p>
      </div>

      {statusQuery.isLoading && <p role="status">Running verification checks…</p>}

      {statusQuery.isError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Could not load verification status. Please try again.
        </p>
      )}

      {statusQuery.isSuccess && (
        <ul className="flex flex-col gap-2">
          {statusQuery.data.checks.map((check) => (
            <li key={check.name} className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm">
              <span
                aria-hidden="true"
                className={`mt-0.5 size-3 shrink-0 rounded-full ${check.status === "pass" ? "bg-green-500" : check.status === "fail" ? "bg-red-500" : "bg-muted-foreground"}`}
              />
              <span className="flex-1">
                <span className="font-medium">{CHECK_LABELS[check.name] ?? check.name}</span>
                <span className={`ml-2 ${check.status === "pass" ? "text-green-700" : "text-red-700"}`}>{check.status === "pass" ? "Passing" : check.status === "fail" ? "Failing" : "Pending"}</span>
                <p className="text-muted-foreground">{check.message}</p>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={() => statusQuery.refetch()} disabled={statusQuery.isFetching}>
          {statusQuery.isFetching ? "Re-running…" : "Re-run Checks"}
        </Button>
        <Button type="button" onClick={onComplete} disabled={!statusQuery.data?.allPassed}>
          Complete Onboarding
        </Button>
      </div>
    </div>
  );
}
