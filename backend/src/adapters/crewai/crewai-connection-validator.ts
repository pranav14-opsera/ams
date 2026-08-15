import { Injectable, Logger } from "@nestjs/common";
import type { ConnectionValidationResult, HealthProbeResult } from "../interfaces/agent-adapter.interface";

const VALIDATION_TIMEOUT_MS = 60_000; // AC: "within 60 seconds"
const HEALTH_PROBE_TIMEOUT_MS = 10_000;

export interface CrewAiConnectionConfig extends Record<string, unknown> {
  crewConfigEndpoint: string;
  apiKey?: string;
}

function isCrewAiConnectionConfig(config: Record<string, unknown>): config is CrewAiConnectionConfig {
  return typeof config.crewConfigEndpoint === "string" && config.crewConfigEndpoint.length > 0;
}

/** Verifies a CrewAI agent's crew configuration endpoint is reachable and returns a JSON crew structure. */
@Injectable()
export class CrewAiConnectionValidator {
  private readonly logger = new Logger(CrewAiConnectionValidator.name);

  async validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    if (!isCrewAiConnectionConfig(config)) {
      return { valid: false, reason: "connection_config must include a non-empty crewConfigEndpoint." };
    }

    try {
      const response = await this.probe(config, VALIDATION_TIMEOUT_MS);
      if (!response.ok) {
        return { valid: false, reason: `Crew configuration probe returned HTTP ${response.status}.` };
      }
      const body = await response.json().catch(() => null);
      if (!body || typeof body !== "object" || !("crew" in (body as object))) {
        return { valid: false, reason: "Crew configuration response did not contain a valid crew structure." };
      }
      return { valid: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown connection error";
      this.logger.warn(`CrewAI connection validation failed: ${reason}`);
      return { valid: false, reason };
    }
  }

  async getHealthProbe(config: Record<string, unknown>): Promise<HealthProbeResult> {
    if (!isCrewAiConnectionConfig(config)) {
      return { healthy: false, details: { reason: "missing crewConfigEndpoint" } };
    }

    const start = Date.now();
    try {
      const response = await this.probe(config, HEALTH_PROBE_TIMEOUT_MS);
      return { healthy: response.ok, latencyMs: Date.now() - start };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - start, details: { reason: err instanceof Error ? err.message : "Unknown error" } };
    }
  }

  private async probe(config: CrewAiConnectionConfig, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(config.crewConfigEndpoint, {
        method: "GET",
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
