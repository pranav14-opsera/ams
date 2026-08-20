import { describe, expect, it } from "vitest";
import { INITIAL_WIZARD_STATE, wizardReducer } from "./wizard-state";

describe("wizardReducer", () => {
  it("selecting a framework advances to Step 2 and marks the wizard dirty", () => {
    const next = wizardReducer(INITIAL_WIZARD_STATE, { type: "SELECT_FRAMEWORK", framework: "langchain" });
    expect(next.step).toBe(2);
    expect(next.framework).toBe("langchain");
    expect(next.isDirty).toBe(true);
  });

  it("switching frameworks clears the previous framework's field values and errors", () => {
    const withLangchain = wizardReducer(INITIAL_WIZARD_STATE, { type: "SELECT_FRAMEWORK", framework: "langchain" });
    const withValues = wizardReducer(withLangchain, { type: "SET_CONNECTION_FIELD", field: "apiKey", value: "secret" });
    const withErrors = wizardReducer(withValues, { type: "SET_FIELD_ERRORS", errors: { apiKey: "bad" } });

    const switched = wizardReducer(withErrors, { type: "SELECT_FRAMEWORK", framework: "generic_rest" });
    expect(switched.connectionFieldValues).toEqual({});
    expect(switched.fieldErrors).toEqual({});
  });

  it("selecting the SAME framework again is a no-op (does not clear in-progress field values)", () => {
    const withLangchain = wizardReducer(INITIAL_WIZARD_STATE, { type: "SELECT_FRAMEWORK", framework: "langchain" });
    const withValues = wizardReducer(withLangchain, { type: "SET_CONNECTION_FIELD", field: "apiKey", value: "secret" });
    const reselected = wizardReducer(withValues, { type: "SELECT_FRAMEWORK", framework: "langchain" });
    expect(reselected.connectionFieldValues).toEqual({ apiKey: "secret" });
  });

  it("NEXT_STEP/PREVIOUS_STEP preserve every other field's data (back/forward navigation loses nothing)", () => {
    let state = wizardReducer(INITIAL_WIZARD_STATE, { type: "SELECT_FRAMEWORK", framework: "generic_rest" });
    state = wizardReducer(state, { type: "SET_CONNECTION_FIELD", field: "baseUrl", value: "https://example.com" });
    state = wizardReducer(state, { type: "SET_AGENT_NAME", name: "My Agent" });
    state = wizardReducer(state, { type: "NEXT_STEP" }); // -> 3
    state = wizardReducer(state, { type: "SET_TEAM", teamId: "team-1" });
    state = wizardReducer(state, { type: "PREVIOUS_STEP" }); // -> 2

    expect(state.step).toBe(2);
    expect(state.connectionFieldValues).toEqual({ baseUrl: "https://example.com" });
    expect(state.agentName).toBe("My Agent");
    expect(state.teamId).toBe("team-1");
  });

  it("NEXT_STEP/PREVIOUS_STEP never go beyond the 1-4 bounds", () => {
    const atStart = wizardReducer(INITIAL_WIZARD_STATE, { type: "PREVIOUS_STEP" });
    expect(atStart.step).toBe(1);

    let atEnd = INITIAL_WIZARD_STATE;
    for (let i = 0; i < 10; i++) atEnd = wizardReducer(atEnd, { type: "NEXT_STEP" });
    expect(atEnd.step).toBe(4);
  });

  it("AGENT_CREATED records the id and clears isDirty (nothing left to warn about)", () => {
    const dirty = wizardReducer(INITIAL_WIZARD_STATE, { type: "SET_AGENT_NAME", name: "x" });
    expect(dirty.isDirty).toBe(true);
    const created = wizardReducer(dirty, { type: "AGENT_CREATED", agentId: "agent-1" });
    expect(created.createdAgentId).toBe("agent-1");
    expect(created.isDirty).toBe(false);
  });

  it("RESET returns to the initial state", () => {
    const dirty = wizardReducer(INITIAL_WIZARD_STATE, { type: "SET_AGENT_NAME", name: "x" });
    expect(wizardReducer(dirty, { type: "RESET" })).toEqual(INITIAL_WIZARD_STATE);
  });
});
