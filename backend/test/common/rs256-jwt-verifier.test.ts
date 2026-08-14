import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { Rs256JwtVerifier } from "../../src/common/jwt/rs256-jwt-verifier.service";
import { JwtVerificationError } from "../../src/common/jwt/jwt-verifier.port";
import jwtFixtures from "../fixtures/jwt-fixtures.json";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("verifies a real RS256 token signed with the matching private key", async () => {
  const { publicKey, privateKey } = keyPair();
  const token = jwt.sign({ sub: "user-1", tenant_id: "tenant-1" }, privateKey, { algorithm: "RS256" });

  const verifier = new Rs256JwtVerifier(publicKey);
  const claims = await verifier.verify(token);

  assert.equal(claims.sub, "user-1");
  assert.equal(claims.tenant_id, "tenant-1");
});

test("rejects a token signed with a different private key", async () => {
  const { privateKey: wrongPrivateKey } = keyPair();
  const { publicKey } = keyPair(); // a DIFFERENT pair's public key
  const token = jwt.sign({ sub: "user-1", tenant_id: "tenant-1" }, wrongPrivateKey, { algorithm: "RS256" });

  const verifier = new Rs256JwtVerifier(publicKey);
  await assert.rejects(() => verifier.verify(token), JwtVerificationError);
});

test("rejects an expired token", async () => {
  const { publicKey, privateKey } = keyPair();
  const token = jwt.sign({ sub: "user-1", tenant_id: "tenant-1" }, privateKey, { algorithm: "RS256", expiresIn: -10 });

  const verifier = new Rs256JwtVerifier(publicKey);
  await assert.rejects(() => verifier.verify(token), JwtVerificationError);
});

test("rejects a token missing the tenant_id claim", async () => {
  const { publicKey, privateKey } = keyPair();
  const token = jwt.sign({ sub: "user-1" }, privateKey, { algorithm: "RS256" });

  const verifier = new Rs256JwtVerifier(publicKey);
  await assert.rejects(() => verifier.verify(token), JwtVerificationError);
});

test("rejects a token signed with the wrong algorithm (alg confusion)", async () => {
  const { publicKey } = keyPair();
  // HS256 using the PEM public key text itself as an HMAC secret is the
  // classic RS256->HS256 downgrade attack this test guards against.
  const forgedToken = jwt.sign({ sub: "attacker", tenant_id: "tenant-1" }, publicKey, { algorithm: "HS256" });

  const verifier = new Rs256JwtVerifier(publicKey);
  await assert.rejects(() => verifier.verify(forgedToken), JwtVerificationError);
});

test("rejects a tampered token (payload modified after signing)", async () => {
  const { publicKey, privateKey } = keyPair();
  const token = jwt.sign({ sub: "user-1", tenant_id: "tenant-1" }, privateKey, { algorithm: "RS256" });
  const [header, , signature] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ sub: "user-1", tenant_id: "someone-elses-tenant" })).toString("base64url");
  const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

  const verifier = new Rs256JwtVerifier(publicKey);
  await assert.rejects(() => verifier.verify(tamperedToken), JwtVerificationError);
});

// Exercises the committed test/fixtures/jwt-fixtures.json tokens directly
// — these are the same fixtures other test suites (and manual local
// testing) reuse, so a regression in what the fixture generator produced
// is caught here too, not just in ad-hoc per-test tokens above.
test("fixture: valid token verifies with the expected tenant_id/sub", async () => {
  const verifier = new Rs256JwtVerifier(jwtFixtures.publicKeyPem);
  const claims = await verifier.verify(jwtFixtures.tokens.valid);
  assert.equal(claims.tenant_id, jwtFixtures.tenantId);
  assert.equal(claims.sub, jwtFixtures.userId);
});

test("fixture: missingTenantIdClaim/expired/malformed/signedWithWrongKey tokens are all rejected", async () => {
  const verifier = new Rs256JwtVerifier(jwtFixtures.publicKeyPem);
  await assert.rejects(() => verifier.verify(jwtFixtures.tokens.missingTenantIdClaim), JwtVerificationError);
  await assert.rejects(() => verifier.verify(jwtFixtures.tokens.expired), JwtVerificationError);
  await assert.rejects(() => verifier.verify(jwtFixtures.tokens.malformed), JwtVerificationError);
  await assert.rejects(() => verifier.verify(jwtFixtures.tokens.signedWithWrongKey), JwtVerificationError);
});
