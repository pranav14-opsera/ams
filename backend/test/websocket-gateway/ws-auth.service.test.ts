import { test } from "node:test";
import assert from "node:assert/strict";
import { JwtKeyService } from "../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../src/auth/jwt/multi-key-jwt-verifier.service";
import { WsAuthenticationError, WsAuthService } from "../../src/websocket-gateway/ws-auth.service";

function buildAuthService() {
  const keyService = new JwtKeyService();
  const verifier = new MultiKeyJwtVerifier(keyService);
  return { authService: new WsAuthService(verifier), keyService };
}

test("authenticates a valid token passed as the `token` query parameter", async () => {
  const { authService, keyService } = buildAuthService();
  const token = keyService.sign({ tid: "tenant-a", roles: ["platform_admin"] }, "user-1", 900);

  const identity = await authService.authenticate(`/ws/dashboard?token=${token}`);
  assert.equal(identity.tenantId, "tenant-a");
  assert.equal(identity.userId, "user-1");
  assert.deepEqual(identity.roles, ["platform_admin"]);
});

test("rejects a handshake with no token query parameter at all", async () => {
  const { authService } = buildAuthService();
  await assert.rejects(() => authService.authenticate("/ws/dashboard"), WsAuthenticationError);
});

test("rejects a handshake with no URL at all", async () => {
  const { authService } = buildAuthService();
  await assert.rejects(() => authService.authenticate(undefined), WsAuthenticationError);
});

test("rejects a malformed/tampered token", async () => {
  const { authService, keyService } = buildAuthService();
  const token = keyService.sign({ tid: "tenant-a", roles: [] }, "user-1", 900);
  const tampered = token.slice(0, -5) + "aaaaa";

  await assert.rejects(() => authService.authenticate(`/ws/dashboard?token=${tampered}`), WsAuthenticationError);
});

test("rejects a token missing the tenant_id claim", async () => {
  const { authService, keyService } = buildAuthService();
  const token = keyService.sign({ roles: [] }, "user-1", 900); // no `tid` claim at all
  await assert.rejects(() => authService.authenticate(`/ws/dashboard?token=${token}`), WsAuthenticationError);
});

test("an identity with no roles claim at all defaults to an empty array (deny-by-default downstream)", async () => {
  const { authService, keyService } = buildAuthService();
  const token = keyService.sign({ tid: "tenant-a" }, "user-1", 900);
  const identity = await authService.authenticate(`/ws/dashboard?token=${token}`);
  assert.deepEqual(identity.roles, []);
});
