#!/usr/bin/env bash
# Unit tests for sign-image.sh (WO-012), stubbing cosign so these run
# without a real registry/KMS.
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

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc (expected '$expected', got '$actual')"
    FAILURES=$((FAILURES + 1))
  fi
}

STUB_DIR=$(mktemp -d)
CAPTURE_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR" "$CAPTURE_DIR"' EXIT

cat > "$STUB_DIR/cosign" <<STUBEOF
#!/usr/bin/env bash
if [ "\$1" = "sign" ]; then
  exit 0
fi
if [ "\$1" = "attest" ]; then
  prev=""
  for arg in "\$@"; do
    if [ "\$prev" = "--predicate" ]; then
      cp "\$arg" "$CAPTURE_DIR/predicate.json"
    fi
    prev="\$arg"
  done
  exit 0
fi
exit 1
STUBEOF
chmod +x "$STUB_DIR/cosign"

run() {
  PATH="$STUB_DIR:$PATH" \
    IMAGE_REF="123.dkr.ecr.us-east-1.amazonaws.com/ams-backend@sha256:abc" \
    KMS_KEY_ALIAS="alias/ams-prod-image-signing" \
    GIT_SHA="abc1234" \
    PIPELINE_RUN_ID="run-42" \
    SCAN_PASS_TIMESTAMP="2026-08-14T12:00:00Z" \
    bash "$SCRIPT_DIR/sign-image.sh" "$@"
}

out=$(run 2>&1)
code=$?
assert_exit "signs and attests successfully" 0 "$code"

# grep, not python3/jq: a native Windows binary reading an embedded
# /tmp/... path string doesn't reliably resolve it the way bash's own
# (MSYS-path-aware) builtins and coreutils do — confirmed by testing:
# `ls` on the same path succeeds while `python3 -c "...open(path)..."`
# silently fails to find the file. Sticking to bash-native tools avoids
# the whole cross-runtime path-translation problem for this test.
field() {
  grep -o "\"$1\": *\"[^\"]*\"" "$CAPTURE_DIR/predicate.json" | sed -E "s/\"$1\": *\"([^\"]*)\"/\1/"
}

gitSha=$(field gitSha)
assert_eq "predicate carries the git SHA" "abc1234" "$gitSha"

runId=$(field pipelineRunId)
assert_eq "predicate carries the pipeline run ID" "run-42" "$runId"

scanTs=$(field scanPassTimestamp)
assert_eq "predicate carries the scan-pass timestamp" "2026-08-14T12:00:00Z" "$scanTs"

# --- required env vars are enforced ---
missing_out=$(PATH="$STUB_DIR:$PATH" bash "$SCRIPT_DIR/sign-image.sh" 2>&1)
missing_code=$?
assert_exit "fails when required env vars are missing" 1 "$missing_code"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES test(s) failed"
  exit 1
fi
echo "All tests passed"
