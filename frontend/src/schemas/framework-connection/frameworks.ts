import type { AgentFramework } from "@/types/dashboard";

export interface FrameworkOption {
  id: AgentFramework;
  label: string;
  description: string;
  phase: "phase-1" | "phase-2";
  /** AC (constraints): "Phase 1 supports LangChain and generic REST frameworks only; CrewAI and AutoGen schemas must be architecturally supported but not implemented." Shown but not selectable. */
  available: boolean;
}

/** Step 1 (Select Framework) card data — matches FrameworkBadge's own label vocabulary (WO-079's framework-badge.tsx) so the same framework reads identically everywhere in the app. */
export const FRAMEWORK_OPTIONS: FrameworkOption[] = [
  {
    id: "langchain",
    label: "LangChain",
    description: "Agents built with the LangChain framework, reporting telemetry via a callback URL and LangSmith-compatible tracing.",
    phase: "phase-1",
    available: true,
  },
  {
    id: "generic_rest",
    label: "Generic REST",
    description: "Any agent exposing a plain REST API with a health-check endpoint and a telemetry webhook.",
    phase: "phase-1",
    available: true,
  },
  {
    id: "crewai",
    label: "CrewAI",
    description: "Multi-agent crews orchestrated with CrewAI. Coming in Phase 2.",
    phase: "phase-2",
    available: false,
  },
  {
    id: "autogen",
    label: "AutoGen",
    description: "Conversational multi-agent systems built with AutoGen. Coming in Phase 2.",
    phase: "phase-2",
    available: false,
  },
];
