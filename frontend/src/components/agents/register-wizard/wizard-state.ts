import { useReducer } from "react";
import type { AgentFramework } from "@/types/dashboard";

export const WIZARD_STEPS = [1, 2, 3, 4] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardState {
  step: WizardStep;
  framework: AgentFramework | null;
  /** Raw field values keyed by schema field name (Step 2) — persists across back/forward navigation (AC: "without losing other step data"). */
  connectionFieldValues: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  agentName: string;
  description: string;
  teamId: string | null;
  /** Tracks whether the user has touched anything yet — backs the unsaved-changes navigation warning (a pristine, never-touched wizard has nothing worth warning about). */
  isDirty: boolean;
  createdAgentId: string | null;
}

export type WizardAction =
  | { type: "SELECT_FRAMEWORK"; framework: AgentFramework }
  | { type: "SET_CONNECTION_FIELD"; field: string; value: unknown }
  | { type: "SET_FIELD_ERRORS"; errors: Record<string, string> }
  | { type: "SET_AGENT_NAME"; name: string }
  | { type: "SET_DESCRIPTION"; description: string }
  | { type: "SET_TEAM"; teamId: string }
  | { type: "GO_TO_STEP"; step: WizardStep }
  | { type: "NEXT_STEP" }
  | { type: "PREVIOUS_STEP" }
  | { type: "AGENT_CREATED"; agentId: string }
  | { type: "RESET" };

export const INITIAL_WIZARD_STATE: WizardState = {
  step: 1,
  framework: null,
  connectionFieldValues: {},
  fieldErrors: {},
  agentName: "",
  description: "",
  teamId: null,
  isDirty: false,
  createdAgentId: null,
};

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "SELECT_FRAMEWORK":
      // Switching frameworks after already configuring one clears the
      // previous framework's field values/errors — a LangChain apiKey
      // value has no meaning against the REST schema, and stale values
      // sitting in state could otherwise leak into a later submit.
      if (state.framework === action.framework) return state;
      return { ...state, framework: action.framework, connectionFieldValues: {}, fieldErrors: {}, isDirty: true, step: 2 };
    case "SET_CONNECTION_FIELD":
      return {
        ...state,
        connectionFieldValues: { ...state.connectionFieldValues, [action.field]: action.value },
        isDirty: true,
      };
    case "SET_FIELD_ERRORS":
      return { ...state, fieldErrors: action.errors };
    case "SET_AGENT_NAME":
      return { ...state, agentName: action.name, isDirty: true };
    case "SET_DESCRIPTION":
      return { ...state, description: action.description, isDirty: true };
    case "SET_TEAM":
      return { ...state, teamId: action.teamId, isDirty: true };
    case "GO_TO_STEP":
      return { ...state, step: action.step };
    case "NEXT_STEP":
      return { ...state, step: (Math.min(state.step + 1, 4) as WizardStep) };
    case "PREVIOUS_STEP":
      return { ...state, step: (Math.max(state.step - 1, 1) as WizardStep) };
    case "AGENT_CREATED":
      // Registration succeeded server-side — nothing left to lose by
      // leaving the page, so the unsaved-changes warning stands down.
      return { ...state, createdAgentId: action.agentId, isDirty: false };
    case "RESET":
      return INITIAL_WIZARD_STATE;
    default:
      return state;
  }
}

export function useWizardState() {
  return useReducer(wizardReducer, INITIAL_WIZARD_STATE);
}
