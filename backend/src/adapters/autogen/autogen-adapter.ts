import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { BaseAgentAdapter } from "../base-agent-adapter";
import type { AdapterMetadata, ConnectionValidationResult, HealthProbeResult } from "../interfaces/agent-adapter.interface";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";
import { AutoGenConnectionValidator } from "./autogen-connection-validator";
import type { AutoGenTelemetryEnvelope } from "./types/autogen-event.types";

export const AUTOGEN_ADAPTER_VERSION = "1.0.0";

function isEnvelope(value: unknown): value is AutoGenTelemetryEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AutoGenTelemetryEnvelope>;
  return (
    typeof candidate.agent_id === "string" &&
    typeof candidate.tenant_id === "string" &&
    typeof candidate.adapter_version === "string" &&
    !!candidate.event &&
    typeof candidate.event === "object" &&
    typeof (candidate.event as { type?: unknown }).type === "string" &&
    typeof (candidate.event as { conversation_id?: unknown }).conversation_id === "string"
  );
}

/**
 * Translates AutoGen's conversational message-passing model (agent <->
 * agent messages, GroupChat orchestration, nested conversations, and
 * function calls) into the canonical schema. conversation_id/call_id
 * correlation (analogous to LangChain's run_id and CrewAI's crew_id/
 * task_id) computes latency for start/end pairs; every event's metadata
 * preserves the conversational structure — conversationId, senderAgent,
 * receiverAgent, messageSequenceNumber, groupChatId/participants, and
 * parentConversationId/nestingLevel for nested conversations — this
 * WO's own acceptance criteria: preserved "for trace exploration."
 */
@Injectable()
export class AutoGenAdapter extends BaseAgentAdapter {
  private readonly conversationStartTimes = new Map<string, number>();
  private readonly functionCallStartTimes = new Map<string, number>();

  constructor(private readonly connectionValidator: AutoGenConnectionValidator) {
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
      frameworkType: "autogen",
      adapterVersion: AUTOGEN_ADAPTER_VERSION,
      supportedEventTypes: [TelemetryEventType.TRACE, TelemetryEventType.METRIC, TelemetryEventType.ERROR],
    };
  }

  translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent {
    if (!isEnvelope(rawEvent)) {
      throw new BadRequestException("Malformed AutoGen telemetry envelope: expected { agent_id, tenant_id, adapter_version, event } with event.conversation_id.");
    }

    const { event } = rawEvent;
    const base = {
      event_id: randomUUID(),
      agent_id: rawEvent.agent_id,
      tenant_id: rawEvent.tenant_id,
      timestamp: event.timestamp,
      framework_type: "autogen" as const,
      adapter_version: rawEvent.adapter_version,
      raw_payload_hash: createHash("sha256").update(JSON.stringify(rawEvent)).digest("hex"),
    };

    switch (event.type) {
      case "conversation_start":
        this.conversationStartTimes.set(event.conversation_id, Date.parse(event.timestamp));
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { conversationId: event.conversation_id, initiatorAgent: event.initiator_agent ?? null, parentConversationId: null, nestingLevel: 0 },
        };

      case "conversation_end": {
        const latency = this.computeLatency(this.conversationStartTimes, event.conversation_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: latency,
          error_rate: 0,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { conversationId: event.conversation_id, parentConversationId: null, nestingLevel: 0 },
        };
      }

      case "nested_conversation_start":
        this.conversationStartTimes.set(event.conversation_id, Date.parse(event.timestamp));
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { conversationId: event.conversation_id, parentConversationId: event.parent_conversation_id, nestingLevel: event.nesting_level },
        };

      case "nested_conversation_end": {
        const latency = this.computeLatency(this.conversationStartTimes, event.conversation_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: latency,
          error_rate: 0,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { conversationId: event.conversation_id, parentConversationId: event.parent_conversation_id, nestingLevel: event.nesting_level },
        };
      }

      case "agent_message":
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: {
            conversationId: event.conversation_id,
            senderAgent: event.sender_agent,
            receiverAgent: event.receiver_agent,
            messageSequenceNumber: event.message_sequence_number,
          },
        };

      case "function_call":
        this.functionCallStartTimes.set(event.call_id, Date.parse(event.timestamp));
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: event.function_name,
          metadata: { conversationId: event.conversation_id, senderAgent: event.sender_agent, callId: event.call_id },
        };

      case "function_result": {
        const latency = this.computeLatency(this.functionCallStartTimes, event.call_id, event.timestamp);
        return {
          ...base,
          event_type: event.success ? TelemetryEventType.METRIC : TelemetryEventType.ERROR,
          latency_ms: latency,
          error_rate: event.success ? 0 : 1,
          token_consumption: null,
          tool_call_success: event.success,
          tool_call_name: event.function_name,
          metadata: {
            conversationId: event.conversation_id,
            senderAgent: event.sender_agent,
            callId: event.call_id,
            error: event.error?.message ?? null,
          },
        };
      }

      case "group_chat_message":
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: {
            conversationId: event.conversation_id,
            groupChatId: event.group_chat_id,
            senderAgent: event.sender_agent,
            participants: event.participants,
            orchestrator: event.orchestrator ?? null,
            messageSequenceNumber: event.message_sequence_number,
          },
        };

      default: {
        const unrecognized: never = event;
        throw new BadRequestException(`Unrecognized AutoGen event type: ${JSON.stringify(unrecognized)}`);
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
