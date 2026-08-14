#!/usr/bin/env bash
# Build-check gate (WO-011): fails fast, before compilation, if the commit
# being built contains a committed node_modules directory or a sensitive
# file. Runs against the git TREE (git ls-tree), not the working directory —
# a gitignored file sitting untracked on disk is not what this is guarding
# against; a file someone actually committed is.
set -euo pipefail

REF="${1:-HEAD}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ALLOWLIST_FILE="$REPO_ROOT/scripts/build-checks/allowlist.txt"

tree_files() {
  if [ "$REF" = "--staged" ]; then
    # A pre-commit hook runs BEFORE the commit exists — the new content is
    # only in the index, not yet reachable from HEAD. git ls-tree HEAD
    # would check the previous commit and miss exactly what's about to be
    # committed, so the staged tree needs its own path via git write-tree.
    git ls-tree -r --name-only "$(git write-tree)"
  else
    git ls-tree -r --name-only "$REF"
  fi
}

is_allowlisted() {
  local path="$1"
  [ -f "$ALLOWLIST_FILE" ] || return 1
  grep -Fxq "$path" "$ALLOWLIST_FILE"
}

# Exact directory match at any depth — "(^|/)node_modules/" requires a path
# separator (or start-of-string) immediately before "node_modules" and a
# separator immediately after, so "my_node_modules_backup/x" or
# "vendor/node_modules_old/x" do NOT match, only a real node_modules/ dir.
check_node_modules() {
  local hits
  hits=$(tree_files | grep -E '(^|/)node_modules/' || true)
  if [ -n "$hits" ]; then
    echo "Build rejected: NPM packages must not be committed directly. Use package.json and lockfile only." >&2
    echo "$hits" | sed 's/^/  /' >&2
    return 1
  fi
  return 0
}

# One glob-ish pattern per line; matched against each tracked file's
# basename (for extension/exact-name patterns) or full path (for the
# ".env.*" family, which must match ".env.production" but not something
# like "src/environment.ts").
SENSITIVE_PATTERNS=(
  '.env'
  '.env.*'
  '*.pem'
  '*.key'
  '*.p12'
  'id_rsa'
  'id_ed25519'
  'credentials.json'
  'serviceAccountKey.json'
)

check_sensitive_files() {
  local failed=0
  local file base
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    is_allowlisted "$file" && continue
    base=$(basename "$file")
    for pattern in "${SENSITIVE_PATTERNS[@]}"; do
      # shellcheck disable=SC2053 -- intentional glob match, not literal
      if [[ "$base" == $pattern ]]; then
        echo "Build rejected: sensitive file pattern '$pattern' matched by committed file: $file" >&2
        failed=1
      fi
    done
  done < <(tree_files)
  return $failed
}

REQUIRED_GITIGNORE_PATTERNS=(
  'node_modules/'
  '.env'
  '.env.*'
  '*.pem'
  '*.key'
  '*.p12'
  'dist/'
  'coverage/'
  '.DS_Store'
)

check_gitignore_patterns() {
  local gitignore="$REPO_ROOT/.gitignore"
  local missing=()
  if [ ! -f "$gitignore" ]; then
    echo "Build rejected: .gitignore is missing entirely." >&2
    return 1
  fi
  for pattern in "${REQUIRED_GITIGNORE_PATTERNS[@]}"; do
    grep -Fxq "$pattern" "$gitignore" || missing+=("$pattern")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Build rejected: .gitignore is missing required pattern(s):" >&2
    printf '  %s\n' "${missing[@]}" >&2
    return 1
  fi
  return 0
}

main() {
  local status=0
  check_node_modules || status=1
  check_sensitive_files || status=1
  check_gitignore_patterns || status=1
  if [ "$status" -eq 0 ]; then
    echo "OK: no committed node_modules, no sensitive files, .gitignore complete."
  fi
  return $status
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main
  exit $?
fi
