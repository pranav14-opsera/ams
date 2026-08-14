#!/usr/bin/env bash
# Unit tests for verify-image.sh (WO-012), stubbing cosign so these run
# without a real registry/KMS. The stub's attestation payload is a real
# one captured from an actual `cosign attest-blob --type custom` run
# (see the header comment on verify-image.sh) — not hand-built JSON that
# might not match cosign's real DSSE/predicate shape.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" -eq "$actual" ]; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc (expected exit $expected, got $actual)"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc (expected output to contain '$needle')"
    FAILURES=$((FAILURES + 1))
  fi
}

STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

# Real DSSE envelope from an actual `cosign attest-blob --key cosign.key
# --predicate predicate.json --type custom --tlog-upload=false`, where
# predicate.json was {"gitSha": "abc1234", "pipelineRunId": "run-42"}.
REAL_ATTESTATION='{"payloadType":"application/vnd.in-toto+json","payload":"eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjAuMSIsInByZWRpY2F0ZVR5cGUiOiJodHRwczovL2Nvc2lnbi5zaWdzdG9yZS5kZXYvYXR0ZXN0YXRpb24vdjEiLCJzdWJqZWN0IjpbeyJuYW1lIjoidGVzdGZpbGUudHh0IiwiZGlnZXN0Ijp7InNoYTI1NiI6ImU0YTAyMDhhMDU2ODkwM2VlZDI2ZWU1ZTE5MjBmZDZiMzU2MzUyYjkyZTFiZTQzOTdmNzU1Y2VhYjg2ZjIyNDAifX1dLCJwcmVkaWNhdGUiOnsiRGF0YSI6IntcbiAgXCJnaXRTaGFcIjogXCJhYmMxMjM0XCIsXG4gIFwicGlwZWxpbmVSdW5JZFwiOiBcInJ1bi00MlwiXG59XG4iLCJUaW1lc3RhbXAiOiIyMDI2LTA4LTE0VDE3OjU2OjI5WiJ9fQ==","signatures":[{"keyid":"","sig":"MEYCIQCrMaLhJBPiXRbEUzRFyf6GGkOXzcMENd4V/Nn91JmoGQIhAKHKX76KUPtCAB/dA98xaES/8P7k0MZecvE5M+gPAP0p"}]}'

make_stub_cosign() {
  local verify_exit="$1" # 0 = signature verifies, 1 = rejected
  cat > "$STUB_DIR/cosign" <<STUBEOF
#!/usr/bin/env bash
if [ "\$1" = "verify" ]; then
  exit $verify_exit
fi
if [ "\$1" = "verify-attestation" ]; then
  echo '$REAL_ATTESTATION'
  exit 0
fi
exit 1
STUBEOF
  chmod +x "$STUB_DIR/cosign"
}

# --- happy path: signature verifies, attestation matches expected SHA ---
make_stub_cosign 0
out=$(PATH="$STUB_DIR:$PATH" IMAGE_REF="test-image" KMS_KEY_ALIAS="alias/test" EXPECTED_GIT_SHA="abc1234" bash "$SCRIPT_DIR/verify-image.sh" 2>&1)
code=$?
assert_exit "happy path: valid signature + matching attestation" 0 "$code"
assert_contains "happy path reports success" "$out" "OK:"

# --- rejected: cosign verify itself fails (unsigned/tampered image) ---
make_stub_cosign 1
out=$(PATH="$STUB_DIR:$PATH" IMAGE_REF="test-image" KMS_KEY_ALIAS="alias/test" bash "$SCRIPT_DIR/verify-image.sh" 2>&1)
code=$?
assert_exit "rejects when cosign verify fails" 1 "$code"
assert_contains "names it as a signature rejection" "$out" "signature verification failed"

# --- rejected: signature OK but attestation's gitSha doesn't match what's being deployed ---
make_stub_cosign 0
out=$(PATH="$STUB_DIR:$PATH" IMAGE_REF="test-image" KMS_KEY_ALIAS="alias/test" EXPECTED_GIT_SHA="wrongsha" bash "$SCRIPT_DIR/verify-image.sh" 2>&1)
code=$?
assert_exit "rejects a gitSha mismatch (tampered/wrong-commit deploy)" 1 "$code"
assert_contains "names the actual vs expected SHA" "$out" "wrongsha"

# --- no EXPECTED_GIT_SHA supplied: skip that check, still requires a valid signature+attestation ---
make_stub_cosign 0
out=$(PATH="$STUB_DIR:$PATH" IMAGE_REF="test-image" KMS_KEY_ALIAS="alias/test" bash "$SCRIPT_DIR/verify-image.sh" 2>&1)
code=$?
assert_exit "passes when no EXPECTED_GIT_SHA is supplied (signature+attestation alone are enough)" 0 "$code"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES test(s) failed"
  exit 1
fi
echo "All tests passed"
