export const TRACE_STATUSES = ["running", "completed", "failed"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export const TRACE_STEP_STATUSES = ["success", "error"] as const;
export type TraceStepStatus = (typeof TRACE_STEP_STATUSES)[number];

export interface TraceStep {
  stepName: string;
  toolName: string | null;
  durationMs: number;
  status: TraceStepStatus;
  inputSummary: string;
  outputSummary: string;
}

export interface AgentExecutionTrace {
  id: string;
  tenantId: string;
  agentId: string;
  status: TraceStatus;
  startedAt: Date;
  durationMs: number | null;
  steps: TraceStep[];
}
