import { test } from "node:test";
import assert from "node:assert/strict";
import { JwtKeyService } from "../../../src/auth/jwt/jwt-key.service";

const DAY_MS = 24 * 60 * 60 * 1000;

test("signs and verifies a token with the current key", () => {
  const keyService = new JwtKeyService();
  const token = keyService.sign({ tid: "tenant-a", roles: ["clinicians"] }, "user-1", 900);
  const claims = keyService.verify(token);
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.tenant_id, "tenant-a"); // normalized from `tid`
});

test("rotateIfDue does nothing before the key is old enough", () => {
  const keyService = new JwtKeyService();
  const rotated = keyService.rotateIfDue(new Date(Date.now() + 10 * DAY_MS));
  assert.equal(rotated, false);
});

test("rotateIfDue rotates once the key exceeds 23 days old", () => {
  const keyService = new JwtKeyService();
  const kidBefore = keyService.currentKid();
  const rotated = keyService.rotateIfDue(new Date(Date.now() + 24 * DAY_MS));
  assert.equal(rotated, true);
  assert.notEqual(keyService.currentKid(), kidBefore);
});

test("a token signed under the PREVIOUS key still verifies during the 7-day overlap window", () => {
  const keyService = new JwtKeyService();
  const oldToken = keyService.sign({ tid: "tenant-a" }, "user-1", 900);

  const rotationTime = new Date(Date.now() + 24 * DAY_MS);
  keyService.rotateIfDue(rotationTime);

  // Still within 7 days of the rotation — old key must still verify.
  // `now` is passed explicitly and consistently with the simulated
  // rotation time above — verify()'s "is this key still active" check
  // is relative to whatever `now` the caller supplies, not the real
  // wall clock (see verify()'s own doc comment for why).
  const shortlyAfterRotation = new Date(rotationTime.getTime() + 1 * DAY_MS);
  const claims = keyService.verify(oldToken, shortlyAfterRotation);
  assert.equal(claims.sub, "user-1");

  // New tokens use the NEW key.
  const newToken = keyService.sign({ tid: "tenant-a" }, "user-2", 900);
  const newClaims = keyService.verify(newToken, shortlyAfterRotation);
  assert.equal(newClaims.sub, "user-2");
});

test("a token signed under a key retired past the overlap window no longer verifies", () => {
  const keyService = new JwtKeyService();
  const oldToken = keyService.sign({ tid: "tenant-a" }, "user-1", 900);

  const rotationTime = new Date(Date.now() + 24 * DAY_MS);
  keyService.rotateIfDue(rotationTime);

  // 10 days after rotation — the old key's 7-day overlap has fully
  // elapsed relative to this same simulated timeline.
  const wellPastOverlap = new Date(rotationTime.getTime() + 10 * DAY_MS);
  assert.throws(() => keyService.verify(oldToken, wellPastOverlap));
});

test("activePublicJwks exposes the current key immediately, and both keys during an overlap window", () => {
  const keyService = new JwtKeyService();
  assert.equal(keyService.activePublicJwks().length, 1);

  keyService.rotateIfDue(new Date(Date.now() + 24 * DAY_MS));
  const jwks = keyService.activePublicJwks();
  assert.equal(jwks.length, 2, "both the new current key and the still-in-overlap previous key must be published");
  for (const jwk of jwks) {
    assert.equal(jwk.kty, "RSA");
    assert.ok(jwk.n);
    assert.ok(jwk.e);
  }
});

test("a tampered token is rejected even though its kid names a real, currently-active key", () => {
  const keyService = new JwtKeyService();
  const token = keyService.sign({ tid: "tenant-a" }, "user-1", 900);
  const parts = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ sub: "attacker", tid: "tenant-a" })).toString("base64url");
  const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

  assert.throws(() => keyService.verify(tampered));
});

test("a token with an unknown kid is rejected outright", () => {
  const keyService = new JwtKeyService();
  const token = keyService.sign({ tid: "tenant-a" }, "user-1", 900);
  const [headerB64, payloadB64, sig] = token.split(".");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  header.kid = "some-unknown-kid";
  const tamperedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");

  assert.throws(() => keyService.verify(`${tamperedHeader}.${payloadB64}.${sig}`));
});
