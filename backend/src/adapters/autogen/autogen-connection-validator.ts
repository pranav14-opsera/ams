import { Injectable, Logger } from "@nestjs/common";
import type { ConnectionValidationResult, HealthProbeResult } from "../interfaces/agent-adapter.interface";

const VALIDATION_TIMEOUT_MS = 60_000; // AC: "within 60 seconds"
const HEALTH_PROBE_TIMEOUT_MS = 10_000;

export interface AutoGenConnectionConfig extends Record<string, unknown> {
  configEndpoint: string;
  apiKey?: string;
}

function isAutoGenConnectionConfig(config: Record<string, unknown>): config is AutoGenConnectionConfig {
  return typeof config.configEndpoint === "string" && config.configEndpoint.length > 0;
}

/** Verifies an AutoGen agent's configuration endpoint is reachable. */
@Injectable()
export class AutoGenConnectionValidator {
  private readonly logger = new Logger(AutoGenConnectionValidator.name);

  async validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    if (!isAutoGenConnectionConfig(config)) {
      return { valid: false, reason: "connection_config must include a non-empty configEndpoint." };
    }

    try {
      const response = await this.probe(config, VALIDATION_TIMEOUT_MS);
      if (!response.ok) {
        return { valid: false, reason: `Configuration probe returned HTTP ${response.status}.` };
      }
      return { valid: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown connection error";
      this.logger.warn(`AutoGen connection validation failed: ${reason}`);
      return { valid: false, reason };
    }
  }

  async getHealthProbe(config: Record<string, unknown>): Promise<HealthProbeResult> {
    if (!isAutoGenConnectionConfig(config)) {
      return { healthy: false, details: { reason: "missing configEndpoint" } };
    }

    const start = Date.now();
    try {
      const response = await this.probe(config, HEALTH_PROBE_TIMEOUT_MS);
      return { healthy: response.ok, latencyMs: Date.now() - start };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - start, details: { reason: err instanceof Error ? err.message : "Unknown error" } };
    }
  }

  private async probe(config: AutoGenConnectionConfig, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(config.configEndpoint, {
        method: "GET",
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
