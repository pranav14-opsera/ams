import { test } from "node:test";
import assert from "node:assert/strict";
import { JwtKeyService } from "../../../src/auth/jwt/jwt-key.service";
import { JwksController } from "../../../src/auth/jwt/jwks.controller";

test("returns the current active key(s) in standard JWKS format", () => {
  const keyService = new JwtKeyService();
  const controller = new JwksController(keyService);

  const response = controller.getJwks();
  assert.equal(response.keys.length, 1);
  assert.equal(response.keys[0].kid, keyService.currentKid());
  assert.equal(response.keys[0].kty, "RSA");
  assert.equal(response.keys[0].alg, "RS256");
});

test("reflects both keys during a rotation overlap window", () => {
  const keyService = new JwtKeyService();
  const controller = new JwksController(keyService);
  keyService.rotateIfDue(new Date(Date.now() + 24 * 24 * 60 * 60 * 1000));

  const response = controller.getJwks();
  assert.equal(response.keys.length, 2);
});
