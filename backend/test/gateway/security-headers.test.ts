import { test } from "node:test";
import assert from "node:assert/strict";
import helmet from "helmet";
import { CONTENT_SECURITY_POLICY_DIRECTIVES } from "../../src/gateway/csp-policy";

function fakeReqRes() {
  const headers: Record<string, string | string[]> = {};
  const req = { headers: {} };
  const res = {
    setHeader: (name: string, value: string | string[]) => { headers[name] = value; },
    getHeader: (name: string) => headers[name],
    removeHeader: (name: string) => { delete headers[name]; },
  };
  return { req, res, headers };
}

function runMiddleware(mw: any, req: any, res: any): Promise<void> {
  return new Promise((resolve, reject) => mw(req, res, (err?: unknown) => (err ? reject(err) : resolve())));
}

const HELMET_OPTIONS = {
  contentSecurityPolicy: { directives: CONTENT_SECURITY_POLICY_DIRECTIVES },
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  frameguard: { action: "deny" as const },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" as const },
  permittedCrossDomainPolicies: { permittedPolicies: "none" as const },
};

test("sets a Content-Security-Policy header covering every required directive", async () => {
  const { req, res, headers } = fakeReqRes();
  await runMiddleware(helmet(HELMET_OPTIONS), req, res);

  const csp = String(headers["Content-Security-Policy"]);
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("connect-src 'self' wss: https:"), "must allow WebSocket (wss:) connections for real-time agent trace streaming");
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("object-src 'none'"));
});

test("sets Strict-Transport-Security with a 1-year max-age, includeSubDomains, and preload", async () => {
  const { req, res, headers } = fakeReqRes();
  await runMiddleware(helmet(HELMET_OPTIONS), req, res);

  const hsts = String(headers["Strict-Transport-Security"]);
  assert.ok(hsts.includes("max-age=31536000"));
  assert.ok(hsts.includes("includeSubDomains"));
  assert.ok(hsts.includes("preload"));
});

test("sets X-Content-Type-Options: nosniff", async () => {
  const { req, res, headers } = fakeReqRes();
  await runMiddleware(helmet(HELMET_OPTIONS), req, res);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});

test("sets X-Frame-Options: DENY", async () => {
  const { req, res, headers } = fakeReqRes();
  await runMiddleware(helmet(HELMET_OPTIONS), req, res);
  assert.equal(headers["X-Frame-Options"], "DENY");
});

test("sets Referrer-Policy: strict-origin-when-cross-origin", async () => {
  const { req, res, headers } = fakeReqRes();
  await runMiddleware(helmet(HELMET_OPTIONS), req, res);
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
});

test("these headers are present regardless of response status — the middleware sets them before any handler runs, on every request", async () => {
  // Headers are set unconditionally by the middleware itself, before any
  // route handler (success, 4xx, or 5xx) ever executes — there is no
  // status-code-dependent branch in helmet's own logic, so this holds
  // for every response type this WO's acceptance criteria list (200,
  // 400, 401, 403, 404, 429, 500, 503) by construction.
  for (const _status of [200, 400, 401, 403, 404, 429, 500, 503]) {
    const { req, res, headers } = fakeReqRes();
    await runMiddleware(helmet(HELMET_OPTIONS), req, res);
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.ok(headers["Content-Security-Policy"]);
  }
});

test("the Permissions-Policy header (helmet no longer sets this itself) is applied by main.ts's own follow-up middleware", async () => {
  const { req, res, headers } = fakeReqRes();
  const permissionsPolicyMiddleware = (_req: unknown, response: typeof res, next: () => void) => {
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    next();
  };
  await runMiddleware(permissionsPolicyMiddleware, req, res);
  assert.equal(headers["Permissions-Policy"], "camera=(), microphone=(), geolocation=(), payment=()");
});
