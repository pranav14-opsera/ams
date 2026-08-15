import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { BaseAgentAdapter } from "../base-agent-adapter";
import type { AdapterMetadata, ConnectionValidationResult } from "../interfaces/agent-adapter.interface";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";
import type { RestTelemetryEventDto } from "./dto/rest-telemetry-event.dto";
import { RestConnectionValidator } from "./rest-connection-validator";
import { RestTelemetryValidatorService } from "./rest-telemetry-validator.service";

export const REST_ADAPTER_VERSION = "1.0.0";

/**
 * The universal fallback adapter: accepts telemetry that already closely
 * mirrors the canonical schema (this WO's own acceptance criteria —
 * "requiring minimal translation"), unlike LangChain's callback-event
 * translation. Registered under the framework_type "generic_rest" (the
 * schema/DB enum value established since WO-031), not the literal string
 * "rest" this WO's own AC shorthands it as — same naming precedent noted
 * in WO-031's create-agent.dto.ts.
 */
@Injectable()
export class GenericRestAdapter extends BaseAgentAdapter {
  constructor(
    private readonly connectionValidator: RestConnectionValidator,
    private readonly restValidator: RestTelemetryValidatorService,
  ) {
    super();
  }

  async validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    return this.connectionValidator.validateConnection(config);
  }

  /** Per-agent health check — see LangChainAdapter.checkAgentHealth() for why this isn't part of IAgentAdapter itself. */
  async checkAgentHealth(config: Record<string, unknown>) {
    return this.connectionValidator.getHealthProbe(config);
  }

  getAdapterMetadata(): AdapterMetadata {
    return {
      frameworkType: "generic_rest",
      adapterVersion: REST_ADAPTER_VERSION,
      supportedEventTypes: [TelemetryEventType.HEARTBEAT, TelemetryEventType.METRIC, TelemetryEventType.TRACE, TelemetryEventType.ERROR],
    };
  }

  translateTelemetry(rawEvent: unknown): CanonicalTelemetryEvent {
    const validation = this.restValidator.validate(rawEvent);
    if (!validation.valid) {
      throw new BadRequestException({ error: "validation_error", message: "REST telemetry event failed schema validation.", details: validation.errors });
    }

    const input = rawEvent as RestTelemetryEventDto;
    return {
      event_id: input.event_id ?? randomUUID(),
      agent_id: input.agent_id,
      tenant_id: input.tenant_id,
      timestamp: input.timestamp ?? new Date().toISOString(),
      event_type: input.event_type as TelemetryEventType,
      // duration_ms/tokens are convenience aliases for callers who don't
      // want to learn the canonical field names — the canonical name
      // wins if a caller (unusually) supplies both.
      latency_ms: input.latency_ms ?? input.duration_ms ?? null,
      error_rate: input.error_rate ?? null,
      token_consumption: input.token_consumption ?? input.tokens ?? null,
      tool_call_success: input.tool_call_success ?? null,
      tool_call_name: input.tool_call_name ?? null,
      framework_type: "generic_rest",
      adapter_version: input.adapter_version ?? REST_ADAPTER_VERSION,
      raw_payload_hash: input.raw_payload_hash ?? createHash("sha256").update(JSON.stringify(rawEvent)).digest("hex"),
      metadata: input.metadata ?? {},
    };
  }
}
