// CrewAI's own event shapes — a hierarchical Crew -> Task -> Agent/Tool
// model, unlike LangChain's flat run_id-correlated callbacks. Every event
// carries crew_id; task-scoped events also carry task_id; agent-scoped
// events also carry agent_role.

interface CrewAIEventBase {
  crew_id: string;
  timestamp: string;
  task_id?: string;
  agent_role?: string;
}

export interface CrewAiUsage {
  total_tokens?: number;
}

export interface CrewKickoffEvent extends CrewAIEventBase {
  type: "crew_kickoff";
  crew_name?: string;
}

export interface CrewCompletedEvent extends CrewAIEventBase {
  type: "crew_completed";
  output?: unknown;
  usage?: CrewAiUsage;
}

export interface TaskStartedEvent extends CrewAIEventBase {
  type: "task_started";
  task_id: string;
  task_description?: string;
}

export interface TaskCompletedEvent extends CrewAIEventBase {
  type: "task_completed";
  task_id: string;
  output?: unknown;
  usage?: CrewAiUsage;
}

export interface TaskFailedEvent extends CrewAIEventBase {
  type: "task_failed";
  task_id: string;
  error: { message: string; name?: string };
}

export interface AgentActionEvent extends CrewAIEventBase {
  type: "agent_action";
  action?: string;
  duration_ms?: number;
}

export interface ToolUsageEvent extends CrewAIEventBase {
  type: "tool_usage";
  tool_name: string;
  success: boolean;
  duration_ms?: number;
}

export interface DelegationEvent extends CrewAIEventBase {
  type: "delegation";
  delegation_from: string;
  delegation_to: string;
  delegation_reason?: string;
}

export type CrewAiEvent =
  | CrewKickoffEvent
  | CrewCompletedEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | AgentActionEvent
  | ToolUsageEvent
  | DelegationEvent;

/** What actually arrives at POST /api/v1/adapters/crewai/telemetry — see LangChainTelemetryEnvelope for why this wrapping exists (CrewAI events, like LangChain's, don't know about tenants/agents). */
export interface CrewAiTelemetryEnvelope {
  agent_id: string;
  tenant_id: string;
  adapter_version: string;
  event: CrewAiEvent;
}
