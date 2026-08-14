import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Rs256JwtIssuerService } from "../../src/auth/jwt/rs256-jwt-issuer.service";
import { Rs256JwtVerifier } from "../../src/common/jwt/rs256-jwt-verifier.service";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("a token issued by Rs256JwtIssuerService verifies with Rs256JwtVerifier (the WO-013 middleware's own verifier)", async () => {
  const { publicKey, privateKey } = keyPair();
  const issuer = new Rs256JwtIssuerService(privateKey);
  const verifier = new Rs256JwtVerifier(publicKey);

  const token = await issuer.issue({ sub: "user-1", tenant_id: "tenant-a", groups: ["clinicians"], idp_type: "saml" });
  const claims = await verifier.verify(token);

  assert.equal(claims.sub, "user-1");
  assert.equal(claims.tenant_id, "tenant-a");
  assert.deepEqual((claims as any).groups, ["clinicians"]);
  assert.equal((claims as any).idp_type, "saml");
});

test("an issued token respects a custom expiry", async () => {
  const { publicKey, privateKey } = keyPair();
  const issuer = new Rs256JwtIssuerService(privateKey);
  const verifier = new Rs256JwtVerifier(publicKey);

  const token = await issuer.issue({ sub: "user-1", tenant_id: "tenant-a", idp_type: "oidc" }, -10);
  await assert.rejects(() => verifier.verify(token));
});

test("a token signed by a different key does not verify", async () => {
  const { privateKey } = keyPair();
  const { publicKey: wrongPublicKey } = keyPair();
  const issuer = new Rs256JwtIssuerService(privateKey);
  const verifier = new Rs256JwtVerifier(wrongPublicKey);

  const token = await issuer.issue({ sub: "user-1", tenant_id: "tenant-a", idp_type: "saml" });
  await assert.rejects(() => verifier.verify(token));
});
