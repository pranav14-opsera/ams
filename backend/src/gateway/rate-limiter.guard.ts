import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { RATE_LIMIT_CONFIG, RATE_LIMIT_EXEMPT_PATHS } from "./rate-limit.config";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitMetricsService } from "./rate-limit-metrics.service";
import { CircuitBreakerRateLimiterService } from "./circuit-breaker-rate-limiter.service";
import type { RateLimitCheckResult } from "./rate-limiter.port";

function endpointGroup(path: string): string {
  // "/api/v1/agents/123" -> "agents" — coarse enough to keep the
  // Prometheus label cardinality bounded regardless of how many
  // distinct resource ids get requested.
  const match = /^\/?(?:scim\/v2|api\/v1)\/([^/]+)/.exec(path);
  return match?.[1] ?? "other";
}

/**
 * Global, two-tier (per-tenant THEN per-user) sliding-window rate
 * limiter. Runs ahead of RbacGuard (registered in an earlier-imported
 * module — see app.module.ts) so an over-quota caller is rejected
 * before spending any authorization-check work at all.
 */
@Injectable()
export class RateLimiterGuard implements CanActivate {
  constructor(
    private readonly limiter: CircuitBreakerRateLimiterService,
    private readonly config: RateLimitConfigService,
    private readonly metrics: RateLimitMetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    if (RATE_LIMIT_EXEMPT_PATHS.some((p) => req.originalUrl.startsWith(`/${p}`) || req.path.startsWith(`/${p}`))) {
      return true;
    }

    const group = endpointGroup(req.path);

    if (req.tenantId) {
      const tenantLimit = this.config.getTenantLimit(req.tenantId);
      const tenantResult = await this.limiter.checkAndConsume(`tenant:${req.tenantId}`, tenantLimit, RATE_LIMIT_CONFIG.windowSeconds);
      this.recordAndMaybeReject(res, req, "tenant", group, tenantResult);
    }

    if (req.actorId) {
      const userLimit = this.config.getUserLimit(req.roles ?? []);
      const userResult = await this.limiter.checkAndConsume(`user:${req.actorId}`, userLimit, RATE_LIMIT_CONFIG.windowSeconds);
      this.recordAndMaybeReject(res, req, "user", group, userResult);
    }

    return true;
  }

  private recordAndMaybeReject(res: Response, req: Request, scope: "tenant" | "user", group: string, result: RateLimitCheckResult): void {
    this.metrics.recordRemaining(scope, scope === "tenant" ? req.tenantId! : req.actorId!, result.remaining);

    if (!result.allowed) {
      this.metrics.recordHit(scope, group, "denied");
      this.reject(res, req, scope, result);
    }
    this.metrics.recordHit(scope, group, "allowed");

    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.floor(result.resetAt.getTime() / 1000)));

    const consumedRatio = (result.limit - result.remaining) / result.limit;
    if (consumedRatio >= RATE_LIMIT_CONFIG.warningThresholdRatio) {
      res.setHeader("X-RateLimit-Warning", `${scope} limit ${Math.round(consumedRatio * 100)}% consumed`);
    }
  }

  private reject(res: Response, req: Request, scope: "tenant" | "user", result: RateLimitCheckResult): never {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));

    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("X-RateLimit-Reset", String(Math.floor(result.resetAt.getTime() / 1000)));

    throw new HttpException(
      {
        error: "rate_limit_exceeded",
        message: `The ${scope}-level rate limit of ${result.limit} requests/second was exceeded.`,
        retry_after: retryAfterSeconds,
        request_id: requestId,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
