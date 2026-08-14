import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { CircuitBreakerRateLimiterService } from "./circuit-breaker-rate-limiter.service";
import { InMemoryRateLimiterService } from "./in-memory-rate-limiter.service";
import { MetricsController } from "./metrics.controller";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitMetricsService } from "./rate-limit-metrics.service";
import { RateLimiterGuard } from "./rate-limiter.guard";
import { RedisRateLimiterService } from "./redis-rate-limiter.service";

@Module({
  controllers: [MetricsController],
  providers: [
    RedisRateLimiterService,
    InMemoryRateLimiterService,
    CircuitBreakerRateLimiterService,
    RateLimitConfigService,
    RateLimitMetricsService,
    // Global: runs ahead of RbacGuard (RbacModule is imported AFTER this
    // one in app.module.ts) so an over-quota request never reaches
    // authorization-check work at all.
    { provide: APP_GUARD, useClass: RateLimiterGuard },
  ],
  exports: [RateLimitMetricsService],
})
export class GatewayModule {}
