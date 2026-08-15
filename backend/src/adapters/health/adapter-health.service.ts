import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import * as semver from "semver";
import { AdapterRegistryService } from "../adapter-registry.service";
import { AdapterConfigurationRepository, type AdapterHealthStatus } from "./adapter-configuration.repository";
import { AdapterHealthCheckRepository, type AdapterHealthCheckRow } from "./adapter-health-check.repository";

const DEGRADED_THRESHOLD = 3; // AC: "fails 3 consecutive times... status is set to 'degraded'"

export interface CompatibilityMatrixEntry {
  adapterType: string;
  adapterVersion: string;
  supportedFrameworkVersions: string;
  healthStatus: AdapterHealthStatus;
}

export interface CompatibilityWarning {
  compatible: boolean;
  supportedRange: string;
  reason?: string;
}

export interface AdapterHealthDetail {
  adapterType: string;
  healthStatus: AdapterHealthStatus;
  lastHealthCheckAt: Date | null;
  consecutiveFailures: number;
  recentChecks: AdapterHealthCheckRow[];
}

export interface HealthProbeRunResult {
  adapterType: string;
  healthy: boolean;
  status: AdapterHealthStatus;
  responseTimeMs: number | null;
  errorDetails: string | null;
  becameDegraded: boolean;
}

@Injectable()
export class AdapterHealthService {
  private readonly logger = new Logger(AdapterHealthService.name);

  constructor(
    private readonly configRepository: AdapterConfigurationRepository,
    private readonly healthCheckRepository: AdapterHealthCheckRepository,
    private readonly registry: AdapterRegistryService,
  ) {}

  async getCompatibilityMatrix(): Promise<CompatibilityMatrixEntry[]> {
    const rows = await this.configRepository.findAll();
    return rows.map((row) => ({
      adapterType: row.adapter_type,
      adapterVersion: row.adapter_version,
      supportedFrameworkVersions: row.supported_framework_versions,
      healthStatus: row.health_status,
    }));
  }

  async getAdapterHealth(adapterType: string): Promise<AdapterHealthDetail> {
    const config = await this.configRepository.findByType(adapterType);
    if (!config) throw new NotFoundException(`No adapter configuration for type "${adapterType}".`);
    const recentChecks = await this.healthCheckRepository.findRecentByType(adapterType, 10);
    return {
      adapterType: config.adapter_type,
      healthStatus: config.health_status,
      lastHealthCheckAt: config.last_health_check_at,
      consecutiveFailures: config.consecutive_failures,
      recentChecks,
    };
  }

  /**
   * A version check is a WARNING, never a hard block (AC: "returns a
   * warning... not a hard block") — an unparseable framework_version or
   * an unknown adapter_type both degrade to "can't confirm
   * compatibility" rather than throwing, since this is advisory
   * information shown alongside registration, not a gate on it.
   */
  async checkVersionCompatibility(adapterType: string, frameworkVersion: string): Promise<CompatibilityWarning> {
    const config = await this.configRepository.findByType(adapterType);
    if (!config) {
      return { compatible: false, supportedRange: "unknown", reason: `No compatibility data for adapter type "${adapterType}".` };
    }

    const range = config.supported_framework_versions;
    if (range === "*") return { compatible: true, supportedRange: range };

    const coerced = semver.valid(semver.coerce(frameworkVersion));
    if (!coerced || !semver.validRange(range)) {
      return { compatible: false, supportedRange: range, reason: `Could not parse framework version "${frameworkVersion}" against range "${range}".` };
    }

    const compatible = semver.satisfies(coerced, range);
    return compatible ? { compatible: true, supportedRange: range } : { compatible: false, supportedRange: range, reason: `Framework version ${frameworkVersion} is outside the supported range ${range}.` };
  }

  async runHealthProbe(adapterType: string): Promise<HealthProbeRunResult> {
    const config = await this.configRepository.findByType(adapterType);
    if (!config) throw new NotFoundException(`No adapter configuration for type "${adapterType}".`);

    const adapter = this.registry.get(adapterType);
    const start = Date.now();
    let healthy = false;
    let responseTimeMs: number | null = null;
    let errorDetails: string | null = null;

    if (!adapter) {
      errorDetails = `No adapter is currently registered for type "${adapterType}".`;
    } else {
      try {
        const probe = await adapter.getHealthProbe();
        healthy = probe.healthy;
        responseTimeMs = probe.latencyMs ?? Date.now() - start;
        if (!healthy) errorDetails = JSON.stringify(probe.details ?? {});
      } catch (err) {
        errorDetails = err instanceof Error ? err.message : "Unknown health probe error";
      }
    }

    await this.healthCheckRepository.record(adapterType, healthy ? "healthy" : "unhealthy", responseTimeMs, errorDetails);

    const consecutiveFailures = healthy ? 0 : config.consecutive_failures + 1;
    const wasDegraded = config.health_status === "degraded";
    const newStatus: AdapterHealthStatus = healthy ? "healthy" : consecutiveFailures >= DEGRADED_THRESHOLD ? "degraded" : config.health_status;

    await this.configRepository.updateHealth(adapterType, { healthStatus: newStatus, consecutiveFailures, lastHealthCheckAt: new Date() });

    const becameDegraded = newStatus === "degraded" && !wasDegraded;
    if (becameDegraded) {
      // AC: "an alert event is published to the Alert Service" — no
      // dedicated alerting/paging connector exists in this codebase yet
      // (same connector-gap pattern as WO-008/WO-012/WO-015). The durable,
      // queryable record IS adapter_configurations.health_status itself
      // (GET /api/v1/adapters/:type/health surfaces it immediately); this
      // log line is the loud, structured signal an operator's log
      // aggregation / on-call tooling can alert on today.
      this.logger.error(`ALERT: adapter "${adapterType}" is now DEGRADED after ${consecutiveFailures} consecutive failed health probes. Last error: ${errorDetails}`);
    }

    return { adapterType, healthy, status: newStatus, responseTimeMs, errorDetails, becameDegraded };
  }
}
