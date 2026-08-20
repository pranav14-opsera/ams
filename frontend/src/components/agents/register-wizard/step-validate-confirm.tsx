"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { CreateAgentError, useCreateAgentMutation, useRetryValidationMutation } from "@/hooks/useCreateAgentMutation";
import { useConnectionValidationPolling } from "@/hooks/useConnectionValidationPolling";
import type { ApiFieldError, CreateAgentRequest } from "@/types/dashboard";
import { FRAMEWORK_OPTIONS } from "@/schemas/framework-connection/frameworks";

export interface StepValidateConfirmProps {
  request: CreateAgentRequest;
  onFieldErrors: (errors: Record<string, string>) => void;
  onBackToConfigure: () => void;
  onAgentCreated: (agentId: string) => void;
  createdAgentId: string | null;
}

function frameworkLabel(framework: string): string {
  return FRAMEWORK_OPTIONS.find((f) => f.id === framework)?.label ?? framework;
}

/**
 * AC 7/8/9: submits the wizard, shows a 60-second progress indicator with
 * staged status messages, and settles into a success confirmation screen
 * (agent/framework/team/RBAC/credit budget + "View in Registry") or a
 * remediation-guidance error screen that can go back to Step 2 without
 * losing the other steps' data.
 */
export function StepValidateConfirm({ request, onFieldErrors, onBackToConfigure, onAgentCreated, createdAgentId }: StepValidateConfirmProps) {
  const createAgent = useCreateAgentMutation();
  const retryValidation = useRetryValidationMutation();
  const polling = useConnectionValidationPolling(createdAgentId);
  const hasSubmittedRef = useRef(false);

  useEffect(() => {
    if (createdAgentId || hasSubmittedRef.current) return;
    hasSubmittedRef.current = true;
    createAgent.mutate(request, {
      onSuccess: (response) => onAgentCreated(response.id),
      onError: (err) => {
        if (err instanceof CreateAgentError && err.body?.details) {
          const fieldErrors: Record<string, string> = {};
          for (const detail of err.body.details as ApiFieldError[]) fieldErrors[detail.field] = detail.message;
          onFieldErrors(fieldErrors);
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit exactly once per Step-4 entry; createdAgentId flips this off for good.
  }, [createdAgentId]);

  function handleRetry() {
    if (!createdAgentId) return;
    retryValidation.mutate(createdAgentId, { onSuccess: () => polling.retry() });
  }

  if (createAgent.isError && !createdAgentId) {
    const err = createAgent.error;
    const isConflict = err instanceof CreateAgentError && err.status === 409;
    return (
      <div className="flex flex-col gap-4">
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-medium">{isConflict ? "An agent with this name already exists." : "Registration failed."}</p>
          <p>{err instanceof Error ? err.message : "Please try again."}</p>
          {isConflict && <p>Go back and choose a different agent name.</p>}
        </div>
        <Button type="button" variant="outline" onClick={onBackToConfigure}>
          Back to Configure Connection
        </Button>
      </div>
    );
  }

  if (createAgent.isPending || (!createdAgentId && !createAgent.isError)) {
    return (
      <div className="flex flex-col items-center gap-3 py-8" role="status">
        <p className="text-sm">Registering agent…</p>
      </div>
    );
  }

  if (polling.phase === "validating" || polling.phase === "idle") {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div aria-hidden="true" className="border-primary size-8 animate-spin rounded-full border-2 border-t-transparent" />
        <p role="status" aria-live="polite" className="text-sm font-medium">
          {polling.progressMessage}
        </p>
        <p className="text-muted-foreground text-xs">This can take up to 60 seconds.</p>
      </div>
    );
  }

  if (polling.phase === "success") {
    const agent = polling.agent;
    return (
      <div className="flex flex-col gap-4">
        <div role="status" className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-green-900">
          <p className="font-medium">Agent registered successfully.</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Agent name</dt>
          <dd>{agent?.name ?? request.name}</dd>
          <dt className="text-muted-foreground">Framework</dt>
          <dd>{frameworkLabel(agent?.framework ?? request.framework)}</dd>
          <dt className="text-muted-foreground">Team</dt>
          <dd>{agent?.team?.name ?? "—"}</dd>
          <dt className="text-muted-foreground">Applied RBAC policies</dt>
          <dd>{agent?.appliedPolicies?.rbac.length ? agent.appliedPolicies.rbac.join(", ") : "None"}</dd>
          <dt className="text-muted-foreground">Credit budget</dt>
          <dd>{agent?.appliedPolicies?.creditBudget ? `${agent.appliedPolicies.creditBudget.amount} ${agent.appliedPolicies.creditBudget.currency}` : "No budget allocated to this team yet"}</dd>
        </dl>
        <Button asChild>
          <Link href="/agents/registry">View in Registry</Link>
        </Button>
      </div>
    );
  }

  // error or timeout
  return (
    <div className="flex flex-col gap-4">
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-red-900">
        <p className="font-medium">{polling.phase === "timeout" ? "Connection validation timed out." : "Connection validation failed."}</p>
        <p className="text-sm">{polling.errorMessage}</p>
        <p className="text-sm">Verify the endpoint is reachable from the internet, then retry, or go back to correct the configuration.</p>
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={handleRetry} disabled={retryValidation.isPending}>
          {retryValidation.isPending ? "Retrying…" : "Retry"}
        </Button>
        <Button type="button" variant="outline" onClick={onBackToConfigure}>
          Back to Configure Connection
        </Button>
        <Button type="button" variant="ghost" asChild>
          <Link href="/agents/registry">Save as Draft</Link>
        </Button>
      </div>
    </div>
  );
}
