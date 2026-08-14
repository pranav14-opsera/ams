import { Injectable, Logger } from "@nestjs/common";
import { RATE_LIMIT_CONFIG } from "./rate-limit.config";

/**
 * Per-tenant limit overrides come from a JSON env var — the "environment
 * variable or configuration store" this WO's acceptance criteria call
 * for. Format: {"<tenantId>": <requestsPerSecond>, ...}.
 */
@Injectable()
export class RateLimitConfigService {
  private readonly logger = new Logger(RateLimitConfigService.name);
  private readonly tenantOverrides: Map<string, number>;

  constructor() {
    this.tenantOverrides = this.parseOverrides(process.env.TENANT_RATE_LIMIT_OVERRIDES);
  }

  getTenantLimit(tenantId: string): number {
    return this.tenantOverrides.get(tenantId) ?? RATE_LIMIT_CONFIG.defaultTenantLimitPerSecond;
  }

  /** Per-role tiering: platform_admin gets double the default user limit — an admin's own tooling/scripts legitimately generate more traffic than an individual operator's interactive use. */
  getUserLimit(roles: string[]): number {
    if (roles.includes("platform_admin")) {
      return RATE_LIMIT_CONFIG.defaultUserLimitPerSecond * 2;
    }
    return RATE_LIMIT_CONFIG.defaultUserLimitPerSecond;
  }

  private parseOverrides(raw: string | undefined): Map<string, number> {
    if (!raw) return new Map();
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(parsed));
    } catch (err) {
      this.logger.warn(`TENANT_RATE_LIMIT_OVERRIDES is not valid JSON — ignoring: ${err instanceof Error ? err.message : err}`);
      return new Map();
    }
  }
}
