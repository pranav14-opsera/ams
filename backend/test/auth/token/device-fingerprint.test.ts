import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeviceFingerprint } from "../../../src/auth/token/device-fingerprint";

test("is deterministic for the same User-Agent and IP", () => {
  const a = computeDeviceFingerprint("Mozilla/5.0", "203.0.113.42");
  const b = computeDeviceFingerprint("Mozilla/5.0", "203.0.113.42");
  assert.equal(a, b);
});

test("is the same across different IPs within the same /24 subnet", () => {
  const a = computeDeviceFingerprint("Mozilla/5.0", "203.0.113.5");
  const b = computeDeviceFingerprint("Mozilla/5.0", "203.0.113.250");
  assert.equal(a, b, "same /24 subnet must produce the same fingerprint — mobile/CGNAT clients legitimately hop within it");
});

test("differs across different /24 subnets", () => {
  const a = computeDeviceFingerprint("Mozilla/5.0", "203.0.113.5");
  const b = computeDeviceFingerprint("Mozilla/5.0", "203.0.114.5");
  assert.notEqual(a, b);
});

test("differs for a different User-Agent on the same subnet", () => {
  const a = computeDeviceFingerprint("Mozilla/5.0 (Windows)", "203.0.113.5");
  const b = computeDeviceFingerprint("Mozilla/5.0 (Macintosh)", "203.0.113.5");
  assert.notEqual(a, b);
});

test("handles an IPv4-mapped IPv6 address the same as its plain IPv4 form", () => {
  const a = computeDeviceFingerprint("Mozilla/5.0", "203.0.113.5");
  const b = computeDeviceFingerprint("Mozilla/5.0", "::ffff:203.0.113.5");
  assert.equal(a, b);
});

test("produces a 64-character hex SHA-256 digest", () => {
  const fingerprint = computeDeviceFingerprint("Mozilla/5.0", "203.0.113.5");
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
});
