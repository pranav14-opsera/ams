import { Controller, Get, Header } from "@nestjs/common";
import { NoPermissionRequired } from "../rbac/no-permission-required.decorator";
import { RateLimitMetricsService } from "./rate-limit-metrics.service";

// Scraped by Prometheus over the internal cluster network, not
// authenticated with a platform JWT (no tenant/user context exists for
// a scraper) — same pre-auth posture as /health/*.
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: RateLimitMetricsService) {}

  @Get()
  @NoPermissionRequired()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async getMetrics(): Promise<string> {
    return this.metrics.metricsText();
  }
}
