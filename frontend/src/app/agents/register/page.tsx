"use client";

import { useMemo } from "react";
import { useAppStore } from "@/stores/app-store";
import { MultiStepWizard } from "@/components/agents/register-wizard/multi-step-wizard";
import { StepAssignTeam } from "@/components/agents/register-wizard/step-assign-team";
import { StepConfigureConnection } from "@/components/agents/register-wizard/step-configure-connection";
import { StepSelectFramework } from "@/components/agents/register-wizard/step-select-framework";
import { StepValidateConfirm } from "@/components/agents/register-wizard/step-validate-confirm";
import { validateSchemaValues } from "@/components/agents/register-wizard/field-validation";
import { useWizardState } from "@/components/agents/register-wizard/wizard-state";
import { useUnsavedChangesWarning } from "@/hooks/useUnsavedChangesWarning";
import { resolveFrameworkSchema } from "@/schemas/framework-connection/registry";
import type { CreateAgentRequest } from "@/types/dashboard";

const AGENT_NAME_PATTERN = { min: 3, max: 100 };

function validateAgentName(name: string): string | null {
  if (name.trim().length === 0) return "Agent name is required.";
  if (name.length < AGENT_NAME_PATTERN.min || name.length > AGENT_NAME_PATTERN.max) {
    return `Agent name must be between ${AGENT_NAME_PATTERN.min} and ${AGENT_NAME_PATTERN.max} characters.`;
  }
  return null;
}

/**
 * WO-080: Register New Agent multi-step wizard — implementation_steps'
 * own page shell, composing the reusable MultiStepWizard with each of
 * the four steps and the shared wizard state (useReducer).
 */
export default function RegisterAgentPage() {
  const roles = useAppStore((s) => s.auth.roles);
  const isAdmin = roles.includes("platform_admin");
  const [state, dispatch] = useWizardState();

  const schema = state.framework ? resolveFrameworkSchema(state.framework) : null;
  const agentNameError = state.step >= 2 ? validateAgentName(state.agentName) : null;

  const canGoNext = useMemo(() => {
    if (state.step === 1) return state.framework !== null;
    if (state.step === 2) {
      if (validateAgentName(state.agentName)) return false;
      if (!schema) return true; // Fallback generic form — nothing schema-driven to gate on.
      return Object.keys(validateSchemaValues(schema, state.connectionFieldValues)).length === 0;
    }
    if (state.step === 3) return Boolean(state.teamId);
    return true;
  }, [state.step, state.framework, state.agentName, state.connectionFieldValues, state.teamId, schema]);

  // AC: unsaved-changes warning stands down once registration has actually succeeded (createdAgentId set) — there's nothing left to lose by navigating away.
  useUnsavedChangesWarning(state.isDirty && !state.createdAgentId);

  function handleNext() {
    if (state.step === 2 && schema) {
      const errors = validateSchemaValues(schema, state.connectionFieldValues);
      dispatch({ type: "SET_FIELD_ERRORS", errors });
      if (Object.keys(errors).length > 0) return;
    }
    dispatch({ type: "NEXT_STEP" });
  }

  function handleBack() {
    dispatch({ type: "PREVIOUS_STEP" });
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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Register New Agent</h1>
        <p className="text-muted-foreground text-sm">Connect a new AI agent to your organization in four steps.</p>
      </div>

      {!isAdmin ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          You don&apos;t have permission to register a new agent. Contact a Platform Administrator.
        </p>
      ) : (
        <MultiStepWizard
          currentStep={state.step}
          onBack={handleBack}
          onNext={handleNext}
          canGoBack={state.step > 1 && !validateStepReachedTerminal}
          canGoNext={canGoNext}
          isLastStep={state.step === 3}
          nextLabel={state.step === 3 ? "Continue to Validate & Confirm" : undefined}
          hideNav={isValidateStep}
        >
          {state.step === 1 && (
            <StepSelectFramework selected={state.framework} onSelect={(framework) => dispatch({ type: "SELECT_FRAMEWORK", framework })} />
          )}
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
              onAgentCreated={(agentId) => dispatch({ type: "AGENT_CREATED", agentId })}
              createdAgentId={state.createdAgentId}
            />
          )}
        </MultiStepWizard>
      )}
    </div>
  );
}
