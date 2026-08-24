"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { MultiStepWizard } from "@/components/agents/register-wizard/multi-step-wizard";
import { StepAssignTeam } from "@/components/agents/register-wizard/step-assign-team";
import { StepConfigureConnection } from "@/components/agents/register-wizard/step-configure-connection";
import { StepSelectFramework } from "@/components/agents/register-wizard/step-select-framework";
import { StepValidateConfirm } from "@/components/agents/register-wizard/step-validate-confirm";
import { validateSchemaValues } from "@/components/agents/register-wizard/field-validation";
import { useWizardState } from "@/components/agents/register-wizard/wizard-state";
import { resolveFrameworkSchema } from "@/schemas/framework-connection/registry";
import type { CreateAgentRequest } from "@/types/dashboard";

const AGENT_NAME_LIMITS = { min: 3, max: 100 };

function validateAgentName(name: string): string | null {
  if (name.trim().length === 0) return "Agent name is required.";
  if (name.length < AGENT_NAME_LIMITS.min || name.length > AGENT_NAME_LIMITS.max) {
    return `Agent name must be between ${AGENT_NAME_LIMITS.min} and ${AGENT_NAME_LIMITS.max} characters.`;
  }
  return null;
}

export interface StepFirstAgentProps {
  onSkip: () => void;
  onAgentRegistered: (agentId: string) => void;
}

/**
 * AC 6: embeds the WO-080 Register New Agent wizard as a sub-flow. The
 * tenant context is implicit — every request the embedded wizard makes
 * (GET /api/v1/teams, POST /api/v1/agents) is already scoped to the
 * authenticated caller's own tenant via TenantContextMiddleware, exactly
 * the same as when this wizard is reached from /agents/register
 * directly, so there is no separate "pass tenant context in" prop to
 * thread through — reusing the SAME components WO-080 already built,
 * not a fork of them.
 * edge_case: "First agent registration fails during onboarding: allow
 * the customer to skip agent registration... do not block the rest of
 * the onboarding flow" — the Skip control is available for the entire
 * sub-flow, not just before it starts.
 */
export function StepFirstAgent({ onSkip, onAgentRegistered }: StepFirstAgentProps) {
  const [state, dispatch] = useWizardState();
  const schema = state.framework ? resolveFrameworkSchema(state.framework) : null;
  const agentNameError = state.step >= 2 ? validateAgentName(state.agentName) : null;

  const canGoNext = useMemo(() => {
    if (state.step === 1) return state.framework !== null;
    if (state.step === 2) {
      if (validateAgentName(state.agentName)) return false;
      if (!schema) return true;
      return Object.keys(validateSchemaValues(schema, state.connectionFieldValues)).length === 0;
    }
    if (state.step === 3) return Boolean(state.teamId);
    return true;
  }, [state.step, state.framework, state.agentName, state.connectionFieldValues, state.teamId, schema]);

  function handleNext() {
    if (state.step === 2 && schema) {
      const errors = validateSchemaValues(schema, state.connectionFieldValues);
      dispatch({ type: "SET_FIELD_ERRORS", errors });
      if (Object.keys(errors).length > 0) return;
    }
    dispatch({ type: "NEXT_STEP" });
  }

  const request: CreateAgentRequest | null = useMemo(() => {
    if (!state.framework || !state.teamId) return null;
    const { frameworkVersion, ...rest } = state.connectionFieldValues as { frameworkVersion?: string; [key: string]: unknown };
    return {
      name: state.agentName,
      framework: state.framework,
      teamId: state.teamId,
      connectionConfig: rest,
      description: state.description || undefined,
      frameworkVersion,
    };
  }, [state.framework, state.teamId, state.agentName, state.description, state.connectionFieldValues]);

  const isValidateStep = state.step === 4;
  const validateStepReachedTerminal = isValidateStep && state.createdAgentId !== null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">First Agent Registration</h2>
        <p className="text-muted-foreground text-sm">Register your first agent now, or skip and do this later from the Agent Registry.</p>
      </div>

      {state.createdAgentId ? (
        <p role="status" className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">
          Agent registered — continuing to Team &amp; RBAC Setup.
        </p>
      ) : (
        <>
          <MultiStepWizard
            currentStep={state.step}
            onBack={() => dispatch({ type: "PREVIOUS_STEP" })}
            onNext={handleNext}
            canGoBack={state.step > 1 && !validateStepReachedTerminal}
            canGoNext={canGoNext}
            isLastStep={state.step === 3}
            nextLabel={state.step === 3 ? "Continue to Validate & Confirm" : undefined}
            hideNav={isValidateStep}
          >
            {state.step === 1 && <StepSelectFramework selected={state.framework} onSelect={(framework) => dispatch({ type: "SELECT_FRAMEWORK", framework })} />}
            {state.step === 2 && state.framework && (
              <StepConfigureConnection
                framework={state.framework}
                agentName={state.agentName}
                onAgentNameChange={(name) => dispatch({ type: "SET_AGENT_NAME", name })}
                agentNameError={agentNameError}
                description={state.description}
                onDescriptionChange={(description) => dispatch({ type: "SET_DESCRIPTION", description })}
                connectionFieldValues={state.connectionFieldValues}
                fieldErrors={state.fieldErrors}
                onFieldChange={(field, value) => dispatch({ type: "SET_CONNECTION_FIELD", field, value })}
                onFieldErrorsChange={(errors) => dispatch({ type: "SET_FIELD_ERRORS", errors })}
              />
            )}
            {state.step === 3 && <StepAssignTeam teamId={state.teamId} onSelectTeam={(teamId) => dispatch({ type: "SET_TEAM", teamId })} />}
            {state.step === 4 && request && (
              <StepValidateConfirm
                request={request}
                onFieldErrors={(errors) => dispatch({ type: "SET_FIELD_ERRORS", errors })}
                onBackToConfigure={() => dispatch({ type: "GO_TO_STEP", step: 2 })}
                onAgentCreated={(agentId) => {
                  dispatch({ type: "AGENT_CREATED", agentId });
                  onAgentRegistered(agentId);
                }}
                createdAgentId={state.createdAgentId}
              />
            )}
          </MultiStepWizard>

          <div className="border-t pt-4">
            <Button type="button" variant="ghost" onClick={onSkip}>
              Skip — I will register agents later
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
