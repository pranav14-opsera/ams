import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PhiScrubberService } from "../phi-scrubber/phi-scrubber.service";
import { TraceRepository, type TraceFilters } from "./trace.repository";
import type { AgentExecutionTrace, TraceStep } from "./trace.types";

/**
 * PHI masking is applied here, at READ time, not at write/ingest time —
 * the raw (unscrubbed) `inputSummary`/`outputSummary` stays in
 * `agent_execution_traces` so a genuine compliance audit trail exists
 * (same reasoning migration 045's own doc comment gives); every response
 * this service ever returns to a caller has already had
 * PhiScrubberService applied, so no caller can ever observe the raw
 * value through this service's own surface.
 */
@Injectable()
export class TraceService {
  constructor(
    private readonly repository: TraceRepository,
    private readonly phiScrubber: PhiScrubberService,
  ) {}

  async getAgentTraces(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, filters: TraceFilters): Promise<{ rows: AgentExecutionTrace[]; total: number }> {
    const result = await this.repository.findByAgentId(client, tenantId, agentId, filters);
    return { total: result.total, rows: result.rows.map((trace) => this.scrubTrace(trace)) };
  }

  private scrubTrace(trace: AgentExecutionTrace): AgentExecutionTrace {
    return { ...trace, steps: trace.steps.map((step) => this.scrubStep(step)) };
  }

  private scrubStep(step: TraceStep): TraceStep {
    return {
      ...step,
      inputSummary: this.phiScrubber.scrubText(step.inputSummary, null),
      outputSummary: this.phiScrubber.scrubText(step.outputSummary, null),
    };
  }
}
