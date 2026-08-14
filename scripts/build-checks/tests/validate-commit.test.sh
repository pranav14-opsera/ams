#!/usr/bin/env bash
# Unit tests for validate-commit.sh (WO-011). Each test builds a throwaway
# git repo with specific fixture files, runs the real script against it,
# and asserts the exit code and (where relevant) that stderr names the
# actual offending file — not just "something failed".
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/validate-commit.sh"
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

make_repo() {
  local dir
  dir=$(mktemp -d)
  (cd "$dir" && git init -q && git config user.email a@a.com && git config user.name a)
  echo "$dir"
}

# --- node_modules detection ---
repo=$(make_repo)
mkdir -p "$repo/node_modules/some-pkg"
echo '{}' > "$repo/node_modules/some-pkg/package.json"
(cd "$repo" && git add -A && git commit -q -m x)
out=$(cd "$repo" && bash "$SCRIPT" HEAD 2>&1)
code=$?
assert_exit "detects committed node_modules" 1 "$code"
assert_contains "node_modules error names the offending file" "$out" "node_modules/some-pkg/package.json"
rm -rf "$repo"

# --- node_modules NOT falsely flagged on near-miss names ---
repo=$(make_repo)
mkdir -p "$repo/vendor/node_modules_backup" "$repo/my_node_modules_docs"
echo x > "$repo/vendor/node_modules_backup/note.txt"
echo x > "$repo/my_node_modules_docs/readme.txt"
printf 'node_modules/\n.env\n.env.*\n*.pem\n*.key\n*.p12\ndist/\ncoverage/\n.DS_Store\n' > "$repo/.gitignore"
(cd "$repo" && git add -A && git commit -q -m x)
out=$(cd "$repo" && bash "$SCRIPT" HEAD 2>&1)
code=$?
assert_exit "does not false-positive on node_modules-like names" 0 "$code"
rm -rf "$repo"

# --- each sensitive file pattern ---
for fixture in .env .env.production secret.pem private.key cert.p12 id_rsa id_ed25519 credentials.json serviceAccountKey.json; do
  repo=$(make_repo)
  echo "fake secret" > "$repo/$fixture"
  (cd "$repo" && git add -A && git commit -q -m x)
  out=$(cd "$repo" && bash "$SCRIPT" HEAD 2>&1)
  code=$?
  assert_exit "detects sensitive file: $fixture" 1 "$code"
  assert_contains "sensitive-file error names: $fixture" "$out" "$fixture"
  rm -rf "$repo"
done

# --- sensitive pattern does not false-positive on a similarly-named safe file ---
repo=$(make_repo)
echo "export const x = 1;" > "$repo/environment.ts"
echo "notes about keys" > "$repo/keystone.md"
printf 'node_modules/\n.env\n.env.*\n*.pem\n*.key\n*.p12\ndist/\ncoverage/\n.DS_Store\n' > "$repo/.gitignore"
(cd "$repo" && git add -A && git commit -q -m x)
out=$(cd "$repo" && bash "$SCRIPT" HEAD 2>&1)
code=$?
assert_exit "does not false-positive on environment.ts / keystone.md" 0 "$code"
rm -rf "$repo"

# --- allowlist suppresses a documented exception ---
repo=$(make_repo)
mkdir -p "$repo/scripts/build-checks"
echo "PLACEHOLDER=1" > "$repo/.env.example"
printf 'node_modules/\n.env\n.env.*\n*.pem\n*.key\n*.p12\ndist/\ncoverage/\n.DS_Store\n' > "$repo/.gitignore"
echo ".env.example" > "$repo/scripts/build-checks/allowlist.txt"
(cd "$repo" && git add -A && git commit -q -m x)
out=$(cd "$repo" && bash "$SCRIPT" HEAD 2>&1)
code=$?
assert_exit "allowlisted .env.example is not flagged" 0 "$code"
rm -rf "$repo"

# --- missing .gitignore patterns are reported ---
repo=$(make_repo)
echo "x" > "$repo/README.md"
echo "node_modules/" > "$repo/.gitignore" # missing everything else
(cd "$repo" && git add -A && git commit -q -m x)
out=$(cd "$repo" && bash "$SCRIPT" HEAD 2>&1)
code=$?
assert_exit "detects incomplete .gitignore" 1 "$code"
assert_contains "reports a specific missing pattern" "$out" ".env"
rm -rf "$repo"

# --- --staged catches a violation that's staged but not yet committed
#     (a plain `HEAD` check would miss it entirely — HEAD is still the
#     PREVIOUS commit until `git commit` actually runs) ---
repo=$(make_repo)
printf 'node_modules/\n.env\n.env.*\n*.pem\n*.key\n*.p12\ndist/\ncoverage/\n.DS_Store\n' > "$repo/.gitignore"
echo x > "$repo/README.md"
(cd "$repo" && git add -A && git commit -q -m "initial clean commit")
mkdir -p "$repo/node_modules/bad"
echo '{}' > "$repo/node_modules/bad/package.json"
# -f: node_modules/ is already gitignored, so a plain `git add -A` would
# silently skip it — force-add to simulate someone bypassing .gitignore,
# which is exactly the case this check exists to catch.
(cd "$repo" && git add -f -A) # staged, not committed
out_head=$(cd "$repo" && bash "$SCRIPT" HEAD 2>&1)
code_head=$?
assert_exit "HEAD alone misses a staged-but-uncommitted violation (documents why --staged exists)" 0 "$code_head"
out_staged=$(cd "$repo" && bash "$SCRIPT" --staged 2>&1)
code_staged=$?
assert_exit "--staged catches the same violation before the commit exists" 1 "$code_staged"
assert_contains "--staged error names the offending file" "$out_staged" "node_modules/bad/package.json"
rm -rf "$repo"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES test(s) failed"
  exit 1
fi
echo "All tests passed"
