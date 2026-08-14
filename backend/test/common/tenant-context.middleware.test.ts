import { test } from "node:test";
import assert from "node:assert/strict";
import { TenantContextMiddleware } from "../../src/common/tenant-context.middleware";
import { JwtVerificationError, type JwtVerifierPort, type VerifiedClaims } from "../../src/common/jwt/jwt-verifier.port";

function fakeReq(headers: Record<string, string> = {}) {
  return { headers, originalUrl: "/api/v1/tenants/x", method: "GET" } as any;
}

function fakeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    on() {
      /* no-op: response never actually finishes in these unit tests */
    },
  };
  return res;
}

function fakeClient(queryImpl: (sql: string, params?: unknown[]) => Promise<any>) {
  return { query: queryImpl, release: () => undefined };
}

function fakePool(client: ReturnType<typeof fakeClient>) {
  return { connect: async () => client } as any;
}

test("rejects with 401 when Authorization header is missing", async () => {
  const verifier: JwtVerifierPort = { verify: async () => { throw new Error("should not be called"); } };
  const middleware = new TenantContextMiddleware(fakePool(fakeClient(async () => ({ rows: [] }))), verifier);

  const req = fakeReq();
  const res = fakeRes();
  let nextCalled = false;
  await middleware.use(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("rejects with 401 when the token fails verification", async () => {
  const verifier: JwtVerifierPort = {
    verify: async () => { throw new JwtVerificationError("bad signature"); },
  };
  const middleware = new TenantContextMiddleware(fakePool(fakeClient(async () => ({ rows: [] }))), verifier);

  const req = fakeReq({ authorization: "Bearer garbage" });
  const res = fakeRes();
  await middleware.use(req, res, () => undefined);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, "invalid token");
});

test("rejects with 401 when the tenant referenced by the token is inactive", async () => {
  const claims: VerifiedClaims = { sub: "user-1", tenant_id: "tenant-1" };
  const verifier: JwtVerifierPort = { verify: async () => claims };
  const client = fakeClient(async () => ({ rowCount: 1, rows: [{ is_active: false }] }));
  const middleware = new TenantContextMiddleware(fakePool(client), verifier);

  const req = fakeReq({ authorization: "Bearer valid-looking-token" });
  const res = fakeRes();
  await middleware.use(req, res, () => undefined);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, "tenant is not active");
});

test("rejects with 401 when the tenant referenced by the token does not exist", async () => {
  const claims: VerifiedClaims = { sub: "user-1", tenant_id: "unknown-tenant" };
  const verifier: JwtVerifierPort = { verify: async () => claims };
  const client = fakeClient(async () => ({ rowCount: 0, rows: [] }));
  const middleware = new TenantContextMiddleware(fakePool(client), verifier);

  const req = fakeReq({ authorization: "Bearer valid-looking-token" });
  const res = fakeRes();
  await middleware.use(req, res, () => undefined);

  assert.equal(res.statusCode, 401);
});

test("sets req.tenantId/actorId and calls next() for a valid token and an active tenant", async () => {
  const claims: VerifiedClaims = { sub: "user-1", tenant_id: "tenant-1" };
  const verifier: JwtVerifierPort = { verify: async () => claims };
  const queries: string[] = [];
  const client = fakeClient(async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith("SELECT is_active")) return { rowCount: 1, rows: [{ is_active: true }] };
    return { rows: [] };
  });
  const middleware = new TenantContextMiddleware(fakePool(client), verifier);

  const req = fakeReq({ authorization: "Bearer valid-looking-token" });
  const res = fakeRes();
  let nextCalled = false;
  await middleware.use(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.tenantId, "tenant-1");
  assert.equal(req.actorId, "user-1");
  assert.equal(req.tenantDbClient, client);
  assert.ok(queries.some((q) => q.includes("set_config")), "expected the session variable to actually be set");
});
