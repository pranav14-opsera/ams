import { randomUUID } from "node:crypto";
import type { CrewAiEvent, CrewAiTelemetryEnvelope } from "../../../../src/adapters/crewai/types/crewai-event.types";

export function envelope(event: CrewAiEvent, overrides: Partial<Omit<CrewAiTelemetryEnvelope, "event">> = {}): CrewAiTelemetryEnvelope {
  return { agent_id: randomUUID(), tenant_id: randomUUID(), adapter_version: "1.0.0", ...overrides, event };
}

const CREW_ID = "crew-001";
const TASK_ID = "task-001";
const T0 = "2026-08-15T10:00:00.000Z";
const T1 = "2026-08-15T10:00:02.500Z"; // +2500ms

export const CREW_KICKOFF: CrewAiEvent = { type: "crew_kickoff", crew_id: CREW_ID, timestamp: T0, crew_name: "Research Crew" };
export const CREW_COMPLETED: CrewAiEvent = { type: "crew_completed", crew_id: CREW_ID, timestamp: T1, usage: { total_tokens: 1500 } };

export const TASK_STARTED: CrewAiEvent = { type: "task_started", crew_id: CREW_ID, task_id: TASK_ID, agent_role: "researcher", timestamp: T0, task_description: "Research the topic" };
export const TASK_COMPLETED: CrewAiEvent = { type: "task_completed", crew_id: CREW_ID, task_id: TASK_ID, agent_role: "researcher", timestamp: T1, usage: { total_tokens: 600 } };
export const TASK_FAILED: CrewAiEvent = { type: "task_failed", crew_id: CREW_ID, task_id: TASK_ID, agent_role: "researcher", timestamp: T1, error: { message: "task failed: rate limited for SSN 123-45-6789 request", name: "RateLimitError" } };

export const AGENT_ACTION: CrewAiEvent = { type: "agent_action", crew_id: CREW_ID, task_id: TASK_ID, agent_role: "researcher", timestamp: T0, action: "search_web", duration_ms: 320 };
export const TOOL_USAGE: CrewAiEvent = { type: "tool_usage", crew_id: CREW_ID, task_id: TASK_ID, agent_role: "researcher", timestamp: T0, tool_name: "web_search", success: true, duration_ms: 275 };
export const TOOL_USAGE_FAILURE: CrewAiEvent = { type: "tool_usage", crew_id: CREW_ID, task_id: TASK_ID, agent_role: "researcher", timestamp: T0, tool_name: "web_search", success: false, duration_ms: 100 };

export const DELEGATION: CrewAiEvent = {
  type: "delegation",
  crew_id: CREW_ID,
  task_id: TASK_ID,
  agent_role: "manager",
  timestamp: T0,
  delegation_from: "manager",
  delegation_to: "researcher",
  delegation_reason: "requires domain expertise",
};

export const MALFORMED_ENVELOPE = { agent_id: randomUUID() }; // missing tenant_id/adapter_version/event

/** A full multi-agent crew execution trace: kickoff -> task started -> delegation -> tool usage -> task completed -> crew completed. */
export function fullCrewExecutionTrace(): CrewAiEvent[] {
  return [CREW_KICKOFF, TASK_STARTED, DELEGATION, TOOL_USAGE, TASK_COMPLETED, CREW_COMPLETED];
}
