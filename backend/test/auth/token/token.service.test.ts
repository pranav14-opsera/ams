import { test } from "node:test";
import assert from "node:assert/strict";
import { JwtKeyService } from "../../../src/auth/jwt/jwt-key.service";
import { MultiKeyJwtVerifier } from "../../../src/auth/jwt/multi-key-jwt-verifier.service";
import { TokenService } from "../../../src/auth/token/token.service";
import { InMemoryRefreshTokenStore } from "../../../src/auth/token/in-memory-refresh-token-store.service";
import { InMemoryRbacService } from "../../../src/tenants/ports/in-memory/in-memory-rbac.service";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";
import { SessionService } from "../../../src/auth/session/session.service";
import { InMemorySessionStore } from "../../../src/auth/session/in-memory-session-store.service";
import { TenantSessionPolicyRepository } from "../../../src/auth/session/tenant-session-policy.repository";

// A pure unit test of TokenService's own logic has no real Postgres —
// SessionService.createSession() only ever reads (never writes) via the
// pool, to look up a tenant's session policy, so a minimal fake that
// always reports "no policy row" (falling back to defaults, exactly like
// a real, freshly-provisioned tenant with no policy configured yet) is a
// faithful stand-in, not a shortcut around real behavior.
const fakePool = { query: async () => ({ rows: [] }) } as any;

function buildTokenService() {
  const keyService = new JwtKeyService();
  const refreshTokenStore = new InMemoryRefreshTokenStore();
  const rbac = new InMemoryRbacService();
  const audit = new InMemoryAuditService();
  const sessionService = new SessionService(fakePool, new InMemorySessionStore(), refreshTokenStore, new TenantSessionPolicyRepository(), audit);
  const tokenService = new TokenService(keyService, refreshTokenStore, rbac, audit, sessionService);
  const verifier = new MultiKeyJwtVerifier(keyService);
  return { tokenService, verifier, audit };
}

test("issueTokenPair returns a verifiable access token and a usable refresh token", async () => {
  const { tokenService, verifier } = buildTokenService();
  const tokens = await tokenService.issueTokenPair("user-1", "tenant-a", ["clinicians"], "fingerprint-1");

  assert.ok(tokens.accessToken);
  assert.ok(tokens.refreshToken);
  const claims = await verifier.verify(tokens.accessToken);
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.tenant_id, "tenant-a");
  assert.deepEqual(claims.roles, ["clinicians"]);
  assert.equal(claims.mfa_verified, false);
});

test("access token never contains PHI-shaped fields — only identity/tenant/roles/permissions/mfa claims", async () => {
  const { tokenService, verifier } = buildTokenService();
  const tokens = await tokenService.issueTokenPair("user-1", "tenant-a", ["clinicians"], "fingerprint-1");
  const claims = await verifier.verify(tokens.accessToken);
  const claimKeys = Object.keys(claims);
  const allowedKeys = new Set(["sub", "tid", "tenant_id", "sid", "roles", "permissions", "mfa_verified", "iat", "exp", "jti"]);
  for (const key of claimKeys) {
    assert.ok(allowedKeys.has(key), `unexpected claim "${key}" — access tokens must only ever carry identity/authorization metadata`);
  }
});

test("refreshTokens rotates: old token becomes unusable, new pair is issued", async () => {
  const { tokenService, verifier } = buildTokenService();
  const original = await tokenService.issueTokenPair("user-1", "tenant-a", ["clinicians"], "fingerprint-1");

  const rotated = await tokenService.refreshTokens(original.refreshToken, "fingerprint-1");
  assert.notEqual(rotated.refreshToken, original.refreshToken);
  const claims = await verifier.verify(rotated.accessToken);
  assert.equal(claims.sub, "user-1");

  await assert.rejects(() => tokenService.refreshTokens(original.refreshToken, "fingerprint-1"));
});

test("refreshTokens rejects a device fingerprint mismatch, and the token is still invalidated (not retryable)", async () => {
  const { tokenService, audit } = buildTokenService();
  const original = await tokenService.issueTokenPair("user-1", "tenant-a", ["clinicians"], "fingerprint-1");

  await assert.rejects(() => tokenService.refreshTokens(original.refreshToken, "fingerprint-DIFFERENT"));

  // The mismatch consumed the token — even retrying with the CORRECT
  // fingerprint afterward must not succeed.
  await assert.rejects(() => tokenService.refreshTokens(original.refreshToken, "fingerprint-1"));

  assert.ok(audit.events.some((e) => e.action === "auth.token.refresh_device_mismatch"));
});

test("refreshTokens rejects an unknown/already-consumed token", async () => {
  const { tokenService } = buildTokenService();
  await assert.rejects(() => tokenService.refreshTokens("never-issued-token", "fingerprint-1"));
});

test("a refreshed access token still carries the roles captured at original login", async () => {
  const { tokenService, verifier } = buildTokenService();
  const original = await tokenService.issueTokenPair("user-1", "tenant-a", ["clinicians", "team_lead"], "fingerprint-1");
  const rotated = await tokenService.refreshTokens(original.refreshToken, "fingerprint-1");
  const claims = await verifier.verify(rotated.accessToken);
  assert.deepEqual(claims.roles, ["clinicians", "team_lead"]);
});

test("revoke invalidates a refresh token outright (e.g. logout)", async () => {
  const { tokenService } = buildTokenService();
  const tokens = await tokenService.issueTokenPair("user-1", "tenant-a", [], "fingerprint-1");
  await tokenService.revoke(tokens.refreshToken);
  await assert.rejects(() => tokenService.refreshTokens(tokens.refreshToken, "fingerprint-1"));
});
