import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { BaseAgentAdapter } from "../base-agent-adapter";
import type { AdapterMetadata, ConnectionValidationResult, HealthProbeResult } from "../interfaces/agent-adapter.interface";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";
import { LangChainConnectionValidator } from "./langchain-connection-validator";
import type { LangChainTelemetryEnvelope, LangChainTokenUsageLegacy, LangChainUsageMetadata } from "./types/langchain-callback.types";

export const LANGCHAIN_ADAPTER_VERSION = "1.0.0";

function isEnvelope(value: unknown): value is LangChainTelemetryEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LangChainTelemetryEnvelope>;
  return (
    typeof candidate.agent_id === "string" &&
    typeof candidate.tenant_id === "string" &&
    typeof candidate.adapter_version === "string" &&
    !!candidate.event &&
    typeof candidate.event === "object" &&
    typeof (candidate.event as { type?: unknown }).type === "string"
  );
}

/** Newer usage_metadata (0.3.x) is preferred over legacy llm_output.token_usage (0.2.x); falls back to null when neither is present. */
function extractTokenConsumption(response: { llm_output?: { token_usage?: LangChainTokenUsageLegacy }; usage_metadata?: LangChainUsageMetadata } | undefined): number | null {
  const usageMetadata = response?.usage_metadata?.total_tokens;
  if (typeof usageMetadata === "number") return usageMetadata;
  const legacy = response?.llm_output?.token_usage?.total_tokens;
  if (typeof legacy === "number") return legacy;
  return null;
}

/**
 * Translates LangChain's callback-based telemetry model into the
 * canonical schema (WO-034). LangChain callbacks are start/end pairs
 * correlated by run_id with no duration field of their own — this
 * adapter tracks each run's start timestamp in memory and computes
 * latency_ms when the matching end/error callback arrives. A *_start
 * callback still produces its own canonical TRACE event (latency_ms:
 * null, since the operation hasn't completed yet) rather than being
 * dropped — IAgentAdapter.translateTelemetry() always returns exactly
 * one event per call, so there's no other way to represent "operation
 * started" as its own observable fact.
 */
@Injectable()
export class LangChainAdapter extends BaseAgentAdapter {
  private readonly runStartTimes = new Map<string, number>();

  constructor(private readonly connectionValidator: LangChainConnectionValidator) {
    super();
  }

  async validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    return this.connectionValidator.validateConnection(config);
  }

  /**
   * Per-agent health check — NOT part of IAgentAdapter (that interface's
   * getHealthProbe() takes no arguments, since AdapterRegistryService
   * holds one adapter INSTANCE per framework type, shared across every
   * agent of that framework, with no per-agent connection context of its
   * own). This WO's own AC ("health probes for connected LangChain
   * agents") needs the agent's specific connection_config, so it's
   * exposed here as an additional method a future health-check
   * job/endpoint can call directly with that config.
   */
  async checkAgentHealth(config: Record<string, unknown>): Promise<HealthProbeResult> {
    return this.connectionValidator.getHealthProbe(config);
  }

  getAdapterMetadata(): AdapterMetadata {
    return {
      frameworkType: "langchain",
      adapterVersion: LANGCHAIN_ADAPTER_VERSION,
      supportedEventTypes: [TelemetryEventType.TRACE, TelemetryEventType.METRIC, TelemetryEventType.ERROR],
    };
  }

  translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent {
    if (!isEnvelope(rawEvent)) {
      throw new BadRequestException("Malformed LangChain telemetry envelope: expected { agent_id, tenant_id, adapter_version, event }.");
    }

    const { event } = rawEvent;
    const base = {
      event_id: randomUUID(),
      agent_id: rawEvent.agent_id,
      tenant_id: rawEvent.tenant_id,
      timestamp: event.timestamp,
      framework_type: "langchain" as const,
      adapter_version: rawEvent.adapter_version,
      raw_payload_hash: createHash("sha256").update(JSON.stringify(rawEvent)).digest("hex"),
    };

    switch (event.type) {
      case "on_llm_start":
        this.recordStart(event.run_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id, llmName: event.serialized?.name ?? null },
        };

      case "on_llm_end":
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: this.computeLatency(event.run_id, event.timestamp),
          error_rate: 0,
          token_consumption: extractTokenConsumption(event.response),
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id },
        };

      case "on_llm_error":
        return {
          ...base,
          event_type: TelemetryEventType.ERROR,
          latency_ms: this.computeLatency(event.run_id, event.timestamp),
          error_rate: 1,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id, error: event.error.message },
        };

      case "on_tool_start":
        this.recordStart(event.run_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: event.serialized?.name ?? null,
          metadata: { runId: event.run_id },
        };

      case "on_tool_end":
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: this.computeLatency(event.run_id, event.timestamp),
          error_rate: 0,
          token_consumption: null,
          tool_call_success: true,
          tool_call_name: event.name ?? null,
          metadata: { runId: event.run_id },
        };

      case "on_tool_error":
        return {
          ...base,
          event_type: TelemetryEventType.ERROR,
          latency_ms: this.computeLatency(event.run_id, event.timestamp),
          error_rate: 1,
          token_consumption: null,
          tool_call_success: false,
          tool_call_name: event.name ?? null,
          metadata: { runId: event.run_id, error: event.error.message },
        };

      case "on_chain_start":
        this.recordStart(event.run_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id, chainName: event.serialized?.name ?? null },
        };

      case "on_chain_end":
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: this.computeLatency(event.run_id, event.timestamp),
          error_rate: 0,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id },
        };

      case "on_chain_error":
        return {
          ...base,
          event_type: TelemetryEventType.ERROR,
          latency_ms: this.computeLatency(event.run_id, event.timestamp),
          error_rate: 1,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id, error: event.error.message },
        };

      case "on_retriever_start":
        this.recordStart(event.run_id, event.timestamp);
        return {
          ...base,
          event_type: TelemetryEventType.TRACE,
          latency_ms: null,
          error_rate: null,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id, query: event.query ?? null },
        };

      case "on_retriever_end":
        return {
          ...base,
          event_type: TelemetryEventType.METRIC,
          latency_ms: this.computeLatency(event.run_id, event.timestamp),
          error_rate: 0,
          token_consumption: null,
          tool_call_success: null,
          tool_call_name: null,
          metadata: { runId: event.run_id, documentCount: event.documents?.length ?? null },
        };

      default: {
        const unrecognized: never = event;
        throw new BadRequestException(`Unrecognized LangChain callback event type: ${JSON.stringify(unrecognized)}`);
      }
    }
  }

  private recordStart(runId: string, timestampIso: string): void {
    this.runStartTimes.set(runId, Date.parse(timestampIso));
  }

  /** Returns null (never NaN/negative) when no matching *_start was ever recorded for this run_id — e.g. the adapter process restarted mid-run. */
  private computeLatency(runId: string, endTimestampIso: string): number | null {
    const startedAt = this.runStartTimes.get(runId);
    this.runStartTimes.delete(runId);
    if (startedAt === undefined) return null;
    const latency = Date.parse(endTimestampIso) - startedAt;
    return Number.isFinite(latency) && latency >= 0 ? latency : null;
  }
}
