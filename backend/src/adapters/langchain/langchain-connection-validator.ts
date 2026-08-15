import { Injectable, Logger } from "@nestjs/common";
import type { ConnectionValidationResult, HealthProbeResult } from "../interfaces/agent-adapter.interface";

const VALIDATION_TIMEOUT_MS = 60_000; // AC: "within 60 seconds"
const HEALTH_PROBE_TIMEOUT_MS = 10_000;

export interface LangChainConnectionConfig extends Record<string, unknown> {
  endpointUrl: string;
  apiKey?: string;
}

function isLangChainConnectionConfig(config: Record<string, unknown>): config is LangChainConnectionConfig {
  return typeof config.endpointUrl === "string" && config.endpointUrl.length > 0;
}

/**
 * Verifies a LangChain agent's connection_config actually points at a
 * reachable endpoint before the agent registry accepts it — a
 * lightweight health-check request, not a full telemetry round-trip.
 * Separated from LangChainAdapter itself (implementation_steps' own
 * file layout) since connection validation and telemetry translation
 * are independent concerns with no shared state.
 */
@Injectable()
export class LangChainConnectionValidator {
  private readonly logger = new Logger(LangChainConnectionValidator.name);

  async validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    if (!isLangChainConnectionConfig(config)) {
      return { valid: false, reason: "connection_config must include a non-empty endpointUrl." };
    }

    try {
      const response = await this.probe(config, VALIDATION_TIMEOUT_MS);
      if (!response.ok) {
        return { valid: false, reason: `Health probe returned HTTP ${response.status}.` };
      }
      return { valid: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown connection error";
      this.logger.warn(`LangChain connection validation failed: ${reason}`);
      return { valid: false, reason };
    }
  }

  async getHealthProbe(config: Record<string, unknown>): Promise<HealthProbeResult> {
    if (!isLangChainConnectionConfig(config)) {
      return { healthy: false, details: { reason: "missing endpointUrl" } };
    }

    const start = Date.now();
    try {
      const response = await this.probe(config, HEALTH_PROBE_TIMEOUT_MS);
      return { healthy: response.ok, latencyMs: Date.now() - start };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - start, details: { reason: err instanceof Error ? err.message : "Unknown error" } };
    }
  }

  private async probe(config: LangChainConnectionConfig, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${config.endpointUrl.replace(/\/$/, "")}/health`, {
        method: "GET",
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
