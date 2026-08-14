#!/usr/bin/env bash
# WO-014 acceptance criteria this covers, beyond test_rls_isolation.sh's
# SELECT-count parity check:
#   - "Tenant A cannot ... update, or delete Tenant B's data" (zero rows
#     affected, not just zero rows returned)
#   - "INSERT operations without a matching tenant context are rejected"
#   - "RLS is enforced independently on both sides of a JOIN"
#   - the tenant_context_violations audit trigger (migration 015) actually
#     fires and records what it claims to
#
# Usage: ./test_rls_write_isolation.sh [host] [port] [dbname]
set -euo pipefail

PGHOST="${1:-localhost}"
PGPORT="${2:-5433}"
PGDATABASE="${3:-postgres}"
TENANT_A="11111111-1111-1111-1111-111111111111"
TENANT_B="22222222-2222-2222-2222-222222222222"

# Same deterministic-id formula as seed_two_tenants.sql's fixture_uuid():
# md5(seed)::uuid. Recomputed here in bash so this script needs no lookup
# query to find a specific fixture row's real id.
fixture_uuid() { psql -h "$PGHOST" -p "$PGPORT" -U postgres -d "$PGDATABASE" -tA -c "SELECT md5('$1')::uuid;"; }

as_postgres() { psql -h "$PGHOST" -p "$PGPORT" -U postgres -d "$PGDATABASE" -tA -c "$1"; }
as_ams_app_for_tenant() {
  # $1 = tenant_id to impersonate, $2 = SQL to run in that session.
  # -tA with two -c flags prints "SET" (from the first -c) followed by the
  # second -c's result, each on its own line — tail -1 keeps only the
  # actual query result.
  psql -h "$PGHOST" -p "$PGPORT" -U ams_app -d "$PGDATABASE" -tA -c "SET app.current_tenant = '$1'" -c "$2" | tail -1
}

failures=()

agent_b1="$(fixture_uuid 'agents|B|1')"
user_b1="$(fixture_uuid 'users|B|1')"
team_b1="$(fixture_uuid 'teams|B|1')"

echo "--- cross-tenant UPDATE must affect zero rows ---"
before="$(as_postgres "SELECT name FROM agents WHERE id = '$agent_b1';")"
as_ams_app_for_tenant "$TENANT_A" "UPDATE agents SET name = 'HIJACKED' WHERE id = '$agent_b1';" >/tmp/wo014_update.out
affected=$(tail -1 /tmp/wo014_update.out | grep -oE '[0-9]+' || echo "?")
after="$(as_postgres "SELECT name FROM agents WHERE id = '$agent_b1';")"
if [ "$before" != "$after" ]; then
  failures+=("cross-tenant UPDATE actually changed tenant B's agent row (before='$before' after='$after')")
fi

echo "--- cross-tenant DELETE must affect zero rows ---"
count_before="$(as_postgres "SELECT count(*) FROM users WHERE id = '$user_b1';")"
as_ams_app_for_tenant "$TENANT_A" "DELETE FROM users WHERE id = '$user_b1';" >/dev/null
count_after="$(as_postgres "SELECT count(*) FROM users WHERE id = '$user_b1';")"
if [ "$count_before" != "$count_after" ] || [ "$count_after" != "1" ]; then
  failures+=("cross-tenant DELETE removed tenant B's user row (before=$count_before after=$count_after, expected both=1)")
fi

echo "--- INSERT with a mismatched tenant_id must be rejected, not silently redirected ---"
insert_result=$(psql -h "$PGHOST" -p "$PGPORT" -U ams_app -d "$PGDATABASE" \
  -c "SET app.current_tenant = '$TENANT_A'" \
  -c "INSERT INTO teams (tenant_id, name) VALUES ('$TENANT_B', 'should-be-rejected');" 2>&1 || true)
if ! echo "$insert_result" | grep -qi "row-level security policy"; then
  failures+=("INSERT with mismatched tenant_id was NOT rejected by RLS — got: $insert_result")
fi
leaked=$(as_postgres "SELECT count(*) FROM teams WHERE name = 'should-be-rejected';")
if [ "$leaked" != "0" ]; then
  failures+=("the rejected cross-tenant INSERT somehow persisted a row anyway")
fi

echo "--- RLS enforced independently on both sides of a JOIN (agents x agent_state_transitions) ---"
join_count=$(as_ams_app_for_tenant "$TENANT_A" \
  "SELECT count(*) FROM agents ag JOIN agent_state_transitions t ON t.agent_id = ag.id WHERE ag.id = '$agent_b1' OR t.tenant_id = '$TENANT_B';")
if [ "$join_count" != "0" ]; then
  failures+=("tenant A's session saw $join_count row(s) of tenant B data via a JOIN — RLS did not apply to both sides independently")
fi
# Sanity: the same join, scoped to tenant A's own data, must be non-empty
# (otherwise the zero above would be a vacuous pass, not a real one).
own_join_count=$(as_ams_app_for_tenant "$TENANT_A" \
  "SELECT count(*) FROM agents ag JOIN agent_state_transitions t ON t.agent_id = ag.id WHERE ag.tenant_id = '$TENANT_A';")
if [ "$own_join_count" = "0" ]; then
  failures+=("sanity check failed: tenant A's own join returned 0 rows, so the JOIN isolation check above proves nothing")
fi

echo "--- tenant_context_violations trigger actually fires and records violations ---"
before_violations=$(as_postgres "SELECT count(*) FROM tenant_context_violations;")
psql -h "$PGHOST" -p "$PGPORT" -U ams_app -d "$PGDATABASE" -c "DELETE FROM users WHERE email = 'no-such-fixture-row@nowhere.test';" >/dev/null 2>&1 || true
after_violations=$(as_postgres "SELECT count(*) FROM tenant_context_violations WHERE table_name = 'users' AND operation = 'DELETE';")
if [ "$after_violations" -lt 1 ]; then
  failures+=("a DELETE with no app.current_tenant set did not produce a tenant_context_violations row")
fi

echo "--- INSERT without any tenant context is rejected outright (native RLS error, not silence) ---"
insert_no_context=$(psql -h "$PGHOST" -p "$PGPORT" -U ams_app -d "$PGDATABASE" \
  -c "INSERT INTO teams (tenant_id, name) VALUES ('$TENANT_A', 'should-also-be-rejected');" 2>&1 || true)
if ! echo "$insert_no_context" | grep -qi "row-level security policy"; then
  failures+=("INSERT with app.current_tenant unset was NOT rejected — got: $insert_no_context")
fi

if [ "${#failures[@]}" -gt 0 ]; then
  echo "WRITE-PATH ISOLATION FAILURE(S):"
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi

echo "PASS: cross-tenant UPDATE/DELETE affect zero rows, mismatched/missing-context INSERTs are rejected, JOINs stay tenant-scoped on both sides, and the violation trigger fires."
