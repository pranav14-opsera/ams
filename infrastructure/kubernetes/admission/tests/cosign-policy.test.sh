#!/usr/bin/env bash
# Real tests against the actual Kyverno CLI (not a mock) — verifies the
# ClusterPolicy loads without a schema/parse error, correctly scopes to
# this platform's own ECR images, and genuinely attempts signature
# verification for a matching image (WO-012). It cannot verify a REAL
# signature without a live KMS key + registry (no AWS connector in this
# environment — see infrastructure/terraform/kms/image-signing-key.tf),
# but "attempts and fails to reach the registry" vs. "rejects due to a
# policy/config error" are distinguishable failure modes, and this test
# asserts the former.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_DIR="$(cd "$TEST_DIR/.." && pwd)"
FAILURES=0

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc (expected output to contain '$needle')"
    echo "--- actual output ---"
    echo "$haystack"
    FAILURES=$((FAILURES + 1))
  fi
}

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Substitute a syntactically-real (fictional account ID) ARN — proves the
# policy's attestor keys.kms field is wired correctly, not just present.
sed "s|\${image_signing_kms_key_arn}|arn:aws:kms:us-east-1:123456789012:alias/ams-prod-image-signing|g" \
  "$POLICY_DIR/cosign-policy.yaml" > "$WORK_DIR/policy.yaml"

matching_out=$(kyverno apply "$WORK_DIR/policy.yaml" --resource "$TEST_DIR/matching-image-pod.yaml" 2>&1 || true)
assert_contains "matching AMS image is subject to verification (not silently skipped)" "$matching_out" "verify-cosign-signature"
assert_contains "verification genuinely attempts the registry (real connector gap, not a config error)" "$matching_out" "123456789012.dkr.ecr.us-east-1.amazonaws.com/v2/ams-backend"

nonmatching_out=$(kyverno apply "$WORK_DIR/policy.yaml" --resource "$TEST_DIR/nonmatching-image-pod.yaml" 2>&1 || true)
assert_contains "non-AMS image (coredns) is left untouched by the policy" "$nonmatching_out" "pass: 0, fail: 0, warn: 0, error: 0, skip: 0"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES test(s) failed"
  exit 1
fi
echo "All tests passed"
