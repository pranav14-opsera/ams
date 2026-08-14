import { test } from "node:test";
import assert from "node:assert/strict";
import * as OTPAuth from "otpauth";
import { TotpProviderService } from "../../../src/auth/mfa/totp-provider.service";

function generateCodeAt(base32Secret: string, timestamp: number): string {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(base32Secret), algorithm: "SHA1", digits: 6, period: 30 });
  return totp.generate({ timestamp });
}

test("generateSecret produces a real base32 secret and a valid otpauth:// provisioning URI", () => {
  const provider = new TotpProviderService();
  const { base32Secret, provisioningUri } = provider.generateSecret("AMS Platform", "user@example.com");

  assert.match(base32Secret, /^[A-Z2-7]+=*$/, "must be valid base32");
  assert.ok(provisioningUri.startsWith("otpauth://totp/"));
  assert.ok(provisioningUri.includes("AMS%20Platform") || provisioningUri.includes("AMS+Platform"));
});

test("validate accepts a genuinely correct code for the current time window", () => {
  const provider = new TotpProviderService();
  const { base32Secret } = provider.generateSecret("AMS Platform", "user@example.com");
  const now = Date.now();
  const code = generateCodeAt(base32Secret, now);

  const period = provider.validate(base32Secret, code, now);
  assert.ok(period !== null);
  assert.equal(period, provider.currentPeriod(now));
});

test("validate rejects a wrong code", () => {
  const provider = new TotpProviderService();
  const { base32Secret } = provider.generateSecret("AMS Platform", "user@example.com");
  const now = Date.now();
  const realCode = generateCodeAt(base32Secret, now);
  const wrongCode = realCode === "000000" ? "111111" : "000000";

  assert.equal(provider.validate(base32Secret, wrongCode, now), null);
});

test("validate accepts a code from one period ago (clock skew tolerance)", () => {
  const provider = new TotpProviderService();
  const { base32Secret } = provider.generateSecret("AMS Platform", "user@example.com");
  const now = Date.now();
  const codeFromPreviousPeriod = generateCodeAt(base32Secret, now - 30_000);

  const period = provider.validate(base32Secret, codeFromPreviousPeriod, now);
  assert.equal(period, provider.currentPeriod(now) - 1);
});

test("validate rejects a code from far outside the tolerance window", () => {
  const provider = new TotpProviderService();
  const { base32Secret } = provider.generateSecret("AMS Platform", "user@example.com");
  const now = Date.now();
  const staleCode = generateCodeAt(base32Secret, now - 10 * 60 * 1000); // 10 minutes ago

  assert.equal(provider.validate(base32Secret, staleCode, now), null);
});

test("validate rejects a code generated under a DIFFERENT secret entirely", () => {
  const provider = new TotpProviderService();
  const { base32Secret: secretA } = provider.generateSecret("AMS Platform", "user-a@example.com");
  const { base32Secret: secretB } = provider.generateSecret("AMS Platform", "user-b@example.com");
  const now = Date.now();
  const codeForA = generateCodeAt(secretA, now);

  assert.equal(provider.validate(secretB, codeForA, now), null);
});

test("currentPeriod is stable within the same 30-second window and advances across it", () => {
  const provider = new TotpProviderService();
  const windowStart = Math.floor(Date.now() / 30_000) * 30_000;
  assert.equal(provider.currentPeriod(windowStart), provider.currentPeriod(windowStart + 5000));
  assert.equal(provider.currentPeriod(windowStart + 30_000), provider.currentPeriod(windowStart) + 1);
});
