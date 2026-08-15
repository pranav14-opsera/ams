import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { HmacValidationMiddleware } from "../../src/adapters/hmac-validation.middleware";

const SECRET = randomBytes(32);
const AGENT = { id: "agent-1", tenant_id: "tenant-1", hmac_secret_ciphertext: Buffer.from("ct"), hmac_secret_iv: Buffer.from("iv"), hmac_secret_auth_tag: Buffer.from("tag"), hmac_secret_encrypted_dek: Buffer.from("dek"), hmac_secret_key_version: 1 };

function fakeAgentsRepository(agent: typeof AGENT | null) {
  return { findByIdAcrossTenants: async (_client: unknown, id: string) => (agent && agent.id === id ? agent : null) } as any;
}

function fakeEncryptionService(secret: Buffer) {
  return { decrypt: async () => secret } as any;
}

function fakeReq(overrides: Record<string, unknown> = {}) {
  return { headers: {}, method: "POST", originalUrl: "/api/v1/adapters/generic_rest/telemetry", body: {}, ...overrides } as any;
}

function fakeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
    state,
  } as any;
}

function signBody(body: object, secret: Buffer): string {
  return createHmac("sha256", secret).update(Buffer.from(JSON.stringify(body))).digest("hex");
}

test("allows a request with a valid signature and sets tenantId/telemetryAgentId on the request", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const body = { hello: "world" };
  const req = fakeReq({ headers: { "x-agent-id": "agent-1", "x-signature-256": signBody(body, SECRET) }, body, rawBody: Buffer.from(JSON.stringify(body)) });
  const res = fakeRes();
  let nextCalled = false;

  await middleware.use(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.state.statusCode, undefined, "next() must be called, not a 401 response");
  assert.equal(req.telemetryAgentId, "agent-1");
  assert.equal(req.tenantId, "tenant-1");
});

test("accepts a signature with the sha256= prefix", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const body = { hello: "world" };
  const req = fakeReq({ headers: { "x-agent-id": "agent-1", "x-signature-256": `sha256=${signBody(body, SECRET)}` }, body, rawBody: Buffer.from(JSON.stringify(body)) });
  const res = fakeRes();
  let nextCalled = false;

  await middleware.use(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("rejects a missing X-Signature-256 header with a generic 401", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const req = fakeReq({ headers: { "x-agent-id": "agent-1" } });
  const res = fakeRes();
  let nextCalled = false;

  await middleware.use(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.state.statusCode, 401);
  assert.deepEqual(res.state.body, { error: "unauthorized", message: "Authentication failed" });
});

test("rejects a missing X-Agent-Id header with the same generic 401", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const req = fakeReq({ headers: { "x-signature-256": "deadbeef" } });
  const res = fakeRes();

  await middleware.use(req, res, () => undefined);
  assert.equal(res.state.statusCode, 401);
  assert.deepEqual(res.state.body, { error: "unauthorized", message: "Authentication failed" });
});

test("rejects an unknown agent_id with the same generic 401 (no leakage that the agent doesn't exist)", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(null), fakeEncryptionService(SECRET));
  const req = fakeReq({ headers: { "x-agent-id": "no-such-agent", "x-signature-256": "deadbeef" } });
  const res = fakeRes();

  await middleware.use(req, res, () => undefined);
  assert.equal(res.state.statusCode, 401);
  assert.deepEqual(res.state.body, { error: "unauthorized", message: "Authentication failed" });
});

test("rejects an invalid/tampered signature with the same generic 401", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const body = { hello: "world" };
  const wrongSecret = randomBytes(32);
  const req = fakeReq({ headers: { "x-agent-id": "agent-1", "x-signature-256": signBody(body, wrongSecret) }, body, rawBody: Buffer.from(JSON.stringify(body)) });
  const res = fakeRes();

  await middleware.use(req, res, () => undefined);
  assert.equal(res.state.statusCode, 401);
  assert.deepEqual(res.state.body, { error: "unauthorized", message: "Authentication failed" });
});

test("rejects a well-formed-but-different-length signature without throwing (timingSafeEqual length mismatch guard)", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const body = { hello: "world" };
  const req = fakeReq({ headers: { "x-agent-id": "agent-1", "x-signature-256": "abcd" }, body, rawBody: Buffer.from(JSON.stringify(body)) });
  const res = fakeRes();

  await middleware.use(req, res, () => undefined);
  assert.equal(res.state.statusCode, 401);
});

test("rejects a non-hex signature of the correct length without throwing", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const body = { hello: "world" };
  const validSig = signBody(body, SECRET);
  const nonHex = "z".repeat(validSig.length);
  const req = fakeReq({ headers: { "x-agent-id": "agent-1", "x-signature-256": nonHex }, body, rawBody: Buffer.from(JSON.stringify(body)) });
  const res = fakeRes();

  await middleware.use(req, res, () => undefined);
  assert.equal(res.state.statusCode, 401);
});

test("a signature computed over a DIFFERENT body than what was actually sent is rejected (verifies against rawBody, not just any signature of the right shape)", async () => {
  const middleware = new HmacValidationMiddleware(fakeAgentsRepository(AGENT), fakeEncryptionService(SECRET));
  const actualBody = { hello: "world" };
  const signatureForADifferentBody = signBody({ hello: "someone-else" }, SECRET);
  const req = fakeReq({ headers: { "x-agent-id": "agent-1", "x-signature-256": signatureForADifferentBody }, body: actualBody, rawBody: Buffer.from(JSON.stringify(actualBody)) });
  const res = fakeRes();

  await middleware.use(req, res, () => undefined);
  assert.equal(res.state.statusCode, 401);
});
