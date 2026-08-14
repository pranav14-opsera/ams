import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { RateLimiterGuard } from "../../src/gateway/rate-limiter.guard";
import { RateLimitConfigService } from "../../src/gateway/rate-limit-config.service";
import { RateLimitMetricsService } from "../../src/gateway/rate-limit-metrics.service";
import type { RateLimitCheckResult } from "../../src/gateway/rate-limiter.port";

function fakeLimiter(results: RateLimitCheckResult[]) {
  let i = 0;
  return { checkAndConsume: async () => results[Math.min(i++, results.length - 1)] } as any;
}

function allow(limit: number, remaining: number): RateLimitCheckResult {
  return { allowed: true, limit, remaining, resetAt: new Date(Date.now() + 1000) };
}

function deny(limit: number): RateLimitCheckResult {
  return { allowed: false, limit, remaining: 0, resetAt: new Date(Date.now() + 1000) };
}

function fakeReqRes(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  const req = { tenantId: "t1", actorId: "u1", roles: ["agent_operator"], originalUrl: "/api/v1/agents/1", path: "/api/v1/agents/1", headers: {}, ...overrides };
  const res = { setHeader: (name: string, value: string) => { headers[name] = value; } };
  return { req, res, headers };
}

function fakeContext(req: any, res: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
}

test("allows a request within both tenant and user limits, setting rate-limit headers", async () => {
  const guard = new RateLimiterGuard(fakeLimiter([allow(1000, 900), allow(100, 90)]), new RateLimitConfigService(), new RateLimitMetricsService());
  const { req, res, headers } = fakeReqRes();

  assert.equal(await guard.canActivate(fakeContext(req, res)), true);
  assert.equal(headers["X-RateLimit-Limit"], "100"); // last-checked scope (user) headers win, matching per-request header semantics
  assert.equal(headers["X-RateLimit-Remaining"], "90");
  assert.ok(headers["X-RateLimit-Reset"]);
});

test("denies with a structured 429 when the TENANT limit is exceeded", async () => {
  const guard = new RateLimiterGuard(fakeLimiter([deny(1000)]), new RateLimitConfigService(), new RateLimitMetricsService());
  const { req, res } = fakeReqRes();

  await assert.rejects(
    () => guard.canActivate(fakeContext(req, res)),
    (err: any) => {
      assert.equal(err.getStatus(), 429);
      const body = err.getResponse();
      assert.equal(body.error, "rate_limit_exceeded");
      assert.ok(body.message.includes("tenant"));
      assert.ok(body.retry_after >= 1);
      assert.ok(body.request_id);
      return true;
    },
  );
});

test("denies with a structured 429 when the USER limit is exceeded, even though tenant is fine", async () => {
  const guard = new RateLimiterGuard(fakeLimiter([allow(1000, 500), deny(100)]), new RateLimitConfigService(), new RateLimitMetricsService());
  const { req, res } = fakeReqRes();

  await assert.rejects(
    () => guard.canActivate(fakeContext(req, res)),
    (err: any) => {
      assert.equal(err.getStatus(), 429);
      assert.ok(err.getResponse().message.includes("user"));
      return true;
    },
  );
});

test("sets Retry-After and X-RateLimit-Remaining=0 on a 429", async () => {
  const guard = new RateLimiterGuard(fakeLimiter([deny(1000)]), new RateLimitConfigService(), new RateLimitMetricsService());
  const { req, res, headers } = fakeReqRes();

  await assert.rejects(() => guard.canActivate(fakeContext(req, res)));
  assert.equal(headers["X-RateLimit-Remaining"], "0");
  assert.ok(Number(headers["Retry-After"]) >= 1);
});

test("sets X-RateLimit-Warning once 80% of a limit is consumed", async () => {
  const guard = new RateLimiterGuard(fakeLimiter([allow(1000, 150)]), new RateLimitConfigService(), new RateLimitMetricsService());
  const { req, res, headers } = fakeReqRes({ actorId: undefined }); // tenant-only check for a clean single-scope assertion

  await guard.canActivate(fakeContext(req, res));
  assert.ok(headers["X-RateLimit-Warning"], "850/1000 consumed (85%) must trigger the warning header");
});

test("does NOT set X-RateLimit-Warning below the 80% threshold", async () => {
  const guard = new RateLimiterGuard(fakeLimiter([allow(1000, 500)]), new RateLimitConfigService(), new RateLimitMetricsService());
  const { req, res, headers } = fakeReqRes({ actorId: undefined });

  await guard.canActivate(fakeContext(req, res));
  assert.equal(headers["X-RateLimit-Warning"], undefined);
});

test("exempts /health/* endpoints from rate limiting entirely", async () => {
  const guard = new RateLimiterGuard(
    { checkAndConsume: async () => { throw new Error("must not be called for an exempt path"); } } as any,
    new RateLimitConfigService(),
    new RateLimitMetricsService(),
  );
  const { req, res } = fakeReqRes({ originalUrl: "/health/live", path: "/health/live" });

  assert.equal(await guard.canActivate(fakeContext(req, res)), true);
});

test("exempts /metrics from rate limiting entirely", async () => {
  const guard = new RateLimiterGuard(
    { checkAndConsume: async () => { throw new Error("must not be called for an exempt path"); } } as any,
    new RateLimitConfigService(),
    new RateLimitMetricsService(),
  );
  const { req, res } = fakeReqRes({ originalUrl: "/metrics", path: "/metrics" });

  assert.equal(await guard.canActivate(fakeContext(req, res)), true);
});

test("skips the per-user check entirely when the request has no actorId (e.g. no session yet)", async () => {
  const guard = new RateLimiterGuard(fakeLimiter([allow(1000, 999)]), new RateLimitConfigService(), new RateLimitMetricsService());
  const { req, res } = fakeReqRes({ actorId: undefined });

  assert.equal(await guard.canActivate(fakeContext(req, res)), true);
});

test("platform_admin gets double the default user rate limit", () => {
  const config = new RateLimitConfigService();
  assert.equal(config.getUserLimit(["platform_admin"]), 200);
  assert.equal(config.getUserLimit(["agent_operator"]), 100);
});

test("a configured tenant override takes precedence over the default tenant limit", () => {
  const previous = process.env.TENANT_RATE_LIMIT_OVERRIDES;
  process.env.TENANT_RATE_LIMIT_OVERRIDES = JSON.stringify({ "tenant-special": 5000 });
  try {
    const config = new RateLimitConfigService();
    assert.equal(config.getTenantLimit("tenant-special"), 5000);
    assert.equal(config.getTenantLimit("tenant-ordinary"), 1000);
  } finally {
    if (previous) process.env.TENANT_RATE_LIMIT_OVERRIDES = previous;
    else delete process.env.TENANT_RATE_LIMIT_OVERRIDES;
  }
});
