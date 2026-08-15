import { Injectable, Logger } from "@nestjs/common";
import type { ConnectionValidationResult, HealthProbeResult } from "../interfaces/agent-adapter.interface";

const VALIDATION_TIMEOUT_MS = 60_000; // AC: "within 60 seconds"
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3; // AC: "following up to 3 redirects"

export interface RestConnectionConfig extends Record<string, unknown> {
  healthEndpoint: string;
  apiKey?: string;
  expectedStatus?: number;
}

function isRestConnectionConfig(config: Record<string, unknown>): config is RestConnectionConfig {
  return typeof config.healthEndpoint === "string" && config.healthEndpoint.length > 0;
}

/**
 * Verifies a generic REST agent's connection_config actually points at a
 * reachable, healthy endpoint. Redirects are followed manually (rather
 * than fetch's own `redirect: "follow"`, which has no exposed max-count)
 * so the documented "up to 3 redirects" cap is real, not just described.
 */
@Injectable()
export class RestConnectionValidator {
  private readonly logger = new Logger(RestConnectionValidator.name);

  async validateConnection(config: Record<string, unknown>): Promise<ConnectionValidationResult> {
    if (!isRestConnectionConfig(config)) {
      return { valid: false, reason: "connection_config must include a non-empty health_endpoint." };
    }

    try {
      const response = await this.probeWithRedirects(config, VALIDATION_TIMEOUT_MS);
      const expectedStatus = config.expectedStatus ?? 200;
      if (response.status !== expectedStatus) {
        return { valid: false, reason: `Health probe returned HTTP ${response.status}, expected ${expectedStatus}.` };
      }
      return { valid: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown connection error";
      this.logger.warn(`REST connection validation failed: ${reason}`);
      return { valid: false, reason };
    }
  }

  async getHealthProbe(config: Record<string, unknown>): Promise<HealthProbeResult> {
    if (!isRestConnectionConfig(config)) {
      return { healthy: false, details: { reason: "missing health_endpoint" } };
    }

    const start = Date.now();
    try {
      const response = await this.probeWithRedirects(config, HEALTH_PROBE_TIMEOUT_MS);
      const expectedStatus = config.expectedStatus ?? 200;
      return { healthy: response.status === expectedStatus, latencyMs: Date.now() - start };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - start, details: { reason: err instanceof Error ? err.message : "Unknown error" } };
    }
  }

  private async probeWithRedirects(config: RestConnectionConfig, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let currentUrl = config.healthEndpoint;
      const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined;

      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
        const response = await fetch(currentUrl, { method: "GET", headers, redirect: "manual", signal: controller.signal });
        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get("location");
        if (!isRedirect || !location || redirectCount === MAX_REDIRECTS) {
          return response;
        }
        currentUrl = new URL(location, currentUrl).toString();
      }
      throw new Error("unreachable"); // loop always returns or throws above
    } finally {
      clearTimeout(timeout);
    }
  }
}
