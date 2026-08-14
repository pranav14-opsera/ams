import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionValidationMiddleware } from "../../../src/auth/session/session-validation.middleware";
import { SessionService } from "../../../src/auth/session/session.service";
import { InMemorySessionStore } from "../../../src/auth/session/in-memory-session-store.service";
import { InMemoryRefreshTokenStore } from "../../../src/auth/token/in-memory-refresh-token-store.service";
import { TenantSessionPolicyRepository } from "../../../src/auth/session/tenant-session-policy.repository";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";

const fakePool = { query: async () => ({ rows: [] }) } as any;

function buildRig() {
  const sessionService = new SessionService(fakePool, new InMemorySessionStore(), new InMemoryRefreshTokenStore(), new TenantSessionPolicyRepository(), new InMemoryAuditService());
  const middleware = new SessionValidationMiddleware(sessionService);
  return { sessionService, middleware };
}

function fakeReqRes(sessionId?: string) {
  const req: any = { sessionId, method: "GET", originalUrl: "/api/v1/tenants/x" };
  let statusCode: number | undefined;
  let body: unknown;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
    },
  };
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

test("passes through when the request has no sessionId at all", async () => {
  const { middleware } = buildRig();
  const { req, res } = fakeReqRes(undefined);
  let nextCalled = false;
  await middleware.use(req, res, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled);
});

test("calls next() for a valid, active session", async () => {
  const { sessionService, middleware } = buildRig();
  const session = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");
  const { req, res } = fakeReqRes(session.sessionId);
  let nextCalled = false;
  await middleware.use(req, res, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled);
});

test("returns 401 for an unknown/invalidated session, without calling next()", async () => {
  const { middleware } = buildRig();
  const { req, res, getStatus, getBody } = fakeReqRes("never-created-session");
  let nextCalled = false;
  await middleware.use(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(getStatus(), 401);
  assert.equal((getBody() as any).error, "unauthorized");
});
