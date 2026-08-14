import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { ScimAuthGuard } from "../../src/scim/scim-auth.guard";

function fakeReq(headers: Record<string, string> = {}) {
  return { headers, originalUrl: "/scim/v2/Users", method: "GET" } as any;
}

function fakeRes() {
  const listeners: Record<string, () => void> = {};
  return { statusCode: 200, on: (event: string, cb: () => void) => { listeners[event] = cb; }, fireFinish: () => listeners.finish?.() };
}

function fakeContext(req: any, res: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
}

function fakeClient() {
  const queries: string[] = [];
  return { queries, query: async (sql: string) => { queries.push(sql); return { rows: [] }; }, release: () => undefined };
}

function fakePool(client: ReturnType<typeof fakeClient>) {
  return { connect: async () => client } as any;
}

test("rejects with a SCIM-shaped 401 when no Authorization header is present", async () => {
  const guard = new ScimAuthGuard(fakePool(fakeClient()), { findByRawToken: async () => null } as any);
  await assert.rejects(
    () => guard.canActivate(fakeContext(fakeReq(), fakeRes())),
    (err: any) => {
      assert.equal(err.getStatus(), 401);
      assert.equal(err.getResponse().schemas[0], "urn:ietf:params:scim:api:messages:2.0:Error");
      return true;
    },
  );
});

test("rejects with 401 for an invalid or revoked token", async () => {
  const guard = new ScimAuthGuard(fakePool(fakeClient()), { findByRawToken: async () => null } as any);
  await assert.rejects(
    () => guard.canActivate(fakeContext(fakeReq({ authorization: "Bearer scim_bad" }), fakeRes())),
    (err: any) => {
      assert.equal(err.getStatus(), 401);
      return true;
    },
  );
});

test("a valid token sets req.tenantId, opens a tenant-scoped client, and passes", async () => {
  const client = fakeClient();
  const guard = new ScimAuthGuard(fakePool(client), { findByRawToken: async () => ({ id: "tok-1", tenantId: "tenant-a", description: null, createdAt: new Date(), revokedAt: null }) } as any);
  const req = fakeReq({ authorization: "Bearer scim_good" });
  const res = fakeRes();

  assert.equal(await guard.canActivate(fakeContext(req, res)), true);
  assert.equal(req.tenantId, "tenant-a");
  assert.equal(req.scimTokenId, "tok-1");
  assert.ok(client.queries.some((q) => q.includes("set_config")));
});

test("commits the request-scoped transaction and releases the client when the response finishes with a success status", async () => {
  let committed = false;
  let released = false;
  const client = { query: async (sql: string) => { if (sql === "COMMIT") committed = true; return { rows: [] }; }, release: () => { released = true; } };
  const guard = new ScimAuthGuard(fakePool(client as any), { findByRawToken: async () => ({ id: "tok-1", tenantId: "tenant-a", description: null, createdAt: new Date(), revokedAt: null }) } as any);
  const req = fakeReq({ authorization: "Bearer scim_good" });
  const res = fakeRes();

  await guard.canActivate(fakeContext(req, res));
  res.fireFinish();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(committed, true);
  assert.equal(released, true);
});
