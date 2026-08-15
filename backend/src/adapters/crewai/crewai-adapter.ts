import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { BaseAgentAdapter } from "../base-agent-adapter";
import type { AdapterMetadata, ConnectionValidationResult, HealthProbeResult } from "../interfaces/agent-adapter.interface";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";
import { CrewAiConnectionValidator } from "./crewai-connection-validator";
import type { CrewAiTelemetryEnvelope } from "./types/crewai-event.types";

export const CREWAI_ADAPTER_VERSION = "1.0.0";

function isEnvelope(value: unknown): value is CrewAiTelemetryEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CrewAiTelemetryEnvelope>;
  return (
    typeof candidate.agent_id === "string" &&
    typeof candidate.tenant_id === "string" &&
    typeof candidate.adapter_version === "string" &&
    !!candidate.event &&
    typeof candidate.event === "object" &&
    typeof (candidate.event as { type?: unknown }).type === "string" &&
    typeof (candidate.event as { crew_id?: unknown }).crew_id === "string"
  );
}

/**
 * Translates CrewAI's hierarchical Crew -> Task -> Agent/Tool telemetry
 * model into the canonical schema. Unlike LangChain's flat run_id
 * correlation, CrewAI events carry an explicit crew_id (and, for
 * task-scoped events, task_id) — this adapter preserves that hierarchy
 * in each canonical event's `metadata` as {crewId, taskId, agentRole,
 * parentEventId}, where parentEventId points at whichever ID is one
 * level up the tree (a task's parent is its crew; an agent
 * action/tool-usage/delegation's parent is its task, or the crew if it
 * isn't scoped to a specific task) — this WO's own acceptance criteria:
 * "enabling workflow visualization."
 */
@Injectable()
export class CrewAiAdapter extends BaseAgentAdapter {
  private readonly crewStartTimes = new Map<string, number>();
  private readonly taskStartTimes = new Map<string, number>();

  constructor(private readonly connectionValidator: CrewAiConnectionValidator) {
    super();
  }

  async validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    return this.connectionValidator.validateConnection(config);
  }

  /** Per-agent health check — see LangChainAdapter.checkAgentHealth() for why this isn't part of IAgentAdapter itself. */
  async checkAgentHealth(config: Record<string, unknown>): Promise<HealthProbeResult> {
    return this.connectionValidator.getHealthProbe(config);
  }

  getAdapterMetadata(): AdapterMetadata {
    return {
      frameworkType: "crewai",
      adapterVersion: CREWAI_ADAPTER_VERSION,
      supportedEventTypes: [TelemetryEventType.TRACE, TelemetryEventType.METRIC, TelemetryEventType.ERROR],
    };
  }

  translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent {
    if (!isEnvelope(rawEvent)) {
      throw new BadRequestException("Malformed CrewAI telemetry envelope: expected { agent_id, tenant_id, adapter_version, event } with event.crew_id.");
    }

    const { event } = rawEvent;
    const base = {
      event_id: randomUUID(),
      agent_id: rawEvent.agent_id,
      tenant_id: rawEvent.tenant_id,
      timestamp: event.timestamp,
      framework_type: "crewai" as const,
      adapter_version: rawEvent.adapter_version,
      raw_payload_hash: createHash("sha256").update(JSON.stringify(rawEvent)).digest("hex"),
    };

    const hierarchy = (parentEventId: string | null) => ({
      crewId: event.crew_id,
      taskId: "task_id" in event ? (event.task_id ?? null) : null,
      agentRole: event.agent_role ?? null,
      parentEventId,
    });

    switch (event.type) {
      case "crew_kickoff":
        this.crewStartTimes.set(event.crew_id, Date.parse(event.timestamp));
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { ...hierarchy(null), crewName: event.crew_name ?? null },
        };

      case "crew_completed": {
        const latency = this.computeLatency(this.crewStartTimes, event.crew_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: latency,
          error_rate: 0,
          token_consumption: event.usage?.total_tokens ?? null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: hierarchy(null),
        };
      }

      case "task_started":
        this.taskStartTimes.set(event.task_id, Date.parse(event.timestamp));
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { ...hierarchy(event.crew_id), taskDescription: event.task_description ?? null },
        };

      case "task_completed": {
        const latency = this.computeLatency(this.taskStartTimes, event.task_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: latency,
          error_rate: 0,
          token_consumption: event.usage?.total_tokens ?? null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: hierarchy(event.crew_id),
        };
      }

      case "task_failed": {
        const latency = this.computeLatency(this.taskStartTimes, event.task_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.ERROR,
          latency_ms: latency,
          error_rate: 1,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { ...hierarchy(event.crew_id), error: event.error.message },
        };
      }

      case "agent_action":
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: event.duration_ms ?? null,
          error_rate: 0,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { ...hierarchy(event.task_id ?? event.crew_id), action: event.action ?? null },
        };

      case "tool_usage":
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: event.duration_ms ?? null,
          error_rate: event.success ? 0 : 1,
          token_consumption: null,
          tool_call_success: event.success,
          tool_call_name: event.tool_name,
          metadata: hierarchy(event.task_id ?? event.crew_id),
        };

      case "delegation":
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: {
            ...hierarchy(event.task_id ?? event.crew_id),
            delegationFrom: event.delegation_from,
            delegationTo: event.delegation_to,
            delegationReason: event.delegation_reason ?? null,
          },
        };

      default: {
        const unrecognized: never = event;
        throw new BadRequestException(`Unrecognized CrewAI event type: ${JSON.stringify(unrecognized)}`);
      }
    }
  }

  private computeLatency(startTimes: Map<string, number>, id: string, endTimestampIso: string): number | null {
    const startedAt = startTimes.get(id);
    startTimes.delete(id);
    if (startedAt === undefined) return null;
    const latency = Date.parse(endTimestampIso) - startedAt;
    return Number.isFinite(latency) && latency >= 0 ? latency : null;
  }
}
