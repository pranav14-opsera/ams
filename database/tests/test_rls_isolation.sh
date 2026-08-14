#!/usr/bin/env bash
# Adversarial cross-tenant isolation test (WO-004 acceptance criteria).
#
# For every tenant-scoped table: get the TRUE row count for Tenant B via a
# superuser connection (which bypasses RLS — ground truth for what Tenant B
# is actually supposed to see), then get the count ams_app sees while
# impersonating Tenant B. If RLS is working, these must be equal. If they
# differ, ams_app-as-Tenant-B is seeing rows it shouldn't (most likely
# Tenant A's), which is exactly the cross-tenant leak this test exists to
# catch.
#
# A naive version of this test (checking "does Tenant B see zero rows?")
# is WRONG and was caught by this script's own development: Tenant B has
# its own legitimate seed data, so it always sees a nonzero count under its
# own context — that's correct, not a leak. Only a deviation from Tenant
# B's *true* count indicates an actual isolation failure.
#
# Usage: ./test_rls_isolation.sh [host] [port] [dbname]
set -euo pipefail

PGHOST="${1:-localhost}"
PGPORT="${2:-5433}"
PGDATABASE="${3:-ams_test}"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"

TABLES=(users teams team_members agents audit_events agent_metrics agent_state_transitions rbac_policies credit_transactions)

failures=()

true_count_for() {
  # $1 = table, $2 = tenant_id — bypasses RLS (superuser), ground truth.
  psql -h "$PGHOST" -p "$PGPORT" -U postgres -d "$PGDATABASE" -tA \
    -c "SELECT count(*) FROM $1 WHERE tenant_id = '$2';" | tail -1
}

visible_count_as() {
  # $1 = table, $2 = tenant_id — what ams_app sees while impersonating tenant $2.
  psql -h "$PGHOST" -p "$PGPORT" -U ams_app -d "$PGDATABASE" -tA \
    -c "SET app.current_tenant = '$2'" -c "SELECT count(*) FROM $1;" | tail -1
}

for tbl in "${TABLES[@]}"; do
  true_count=$(true_count_for "$tbl" "$TENANT_B")
  visible_count=$(visible_count_as "$tbl" "$TENANT_B")

  if [ "$true_count" != "$visible_count" ]; then
    failures+=("$tbl: expected $true_count (Tenant B's true count), ams_app-as-Tenant-B saw $visible_count")
  fi
done

# Inverse direction: Tenant A's own view must also match its own true count
# (a functional bug, not a security one, but the same check is free here).
for tbl in "${TABLES[@]}"; do
  true_count=$(true_count_for "$tbl" "$TENANT_A")
  visible_count=$(visible_count_as "$tbl" "$TENANT_A")

  if [ "$true_count" != "$visible_count" ]; then
    failures+=("$tbl: Tenant A expected $true_count, ams_app-as-Tenant-A saw $visible_count")
  fi
done

if [ "${#failures[@]}" -gt 0 ]; then
  echo "CROSS-TENANT ISOLATION FAILURE(S):"
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi

echo "PASS: zero cross-tenant leakage across ${#TABLES[@]} tables (both directions)"
