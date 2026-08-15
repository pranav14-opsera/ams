import { Injectable, Logger } from "@nestjs/common";
import { WS_CONFIG } from "./ws-config";

/**
 * Per-tenant WebSocket connection limit overrides — a JSON env var,
 * same mechanism WO-027's RateLimitConfigService uses for per-tenant
 * REQUEST-rate overrides, but deliberately a SEPARATE config: a
 * connection-count ceiling (default 50) and a requests-per-second
 * ceiling (default 1,000) are different units measuring different
 * things, conflating them into one lookup would be a real bug, not a
 * simplification.
 */
@Injectable()
export class WsConnectionLimitConfigService {
  private readonly logger = new Logger(WsConnectionLimitConfigService.name);
  private readonly tenantOverrides: Map<string, number>;

  constructor() {
    this.tenantOverrides = this.parseOverrides(process.env.TENANT_WS_CONNECTION_LIMIT_OVERRIDES);
  }

  getLimit(tenantId: string): number {
    return this.tenantOverrides.get(tenantId) ?? WS_CONFIG.defaultMaxConnectionsPerTenant;
  }

  private parseOverrides(raw: string | undefined): Map<string, number> {
    if (!raw) return new Map();
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(parsed));
    } catch (err) {
      this.logger.warn(`TENANT_WS_CONNECTION_LIMIT_OVERRIDES is not valid JSON — ignoring: ${err instanceof Error ? err.message : err}`);
      return new Map();
    }
  }
}
