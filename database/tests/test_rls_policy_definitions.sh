#!/usr/bin/env bash
# WO-014 acceptance criteria: "Unit tests cover the migration scripts and
# verify RLS policy creation SQL is correct for each table." This checks
# the actual, applied state of the database's catalogs (pg_policies,
# pg_class.relforcerowsecurity) against what the migrations claim to have
# done — real verification, not a read of the .sql source text.
#
# Usage: ./test_rls_policy_definitions.sh [host] [port] [dbname]
set -euo pipefail

PGHOST="${1:-localhost}"
PGPORT="${2:-5433}"
PGDATABASE="${3:-postgres}"

# The 11 tenant-scoped tables named in WO-014's acceptance criteria.
TABLES=(users teams agents agent_state_transitions rbac_policies abac_policies credit_transactions governance_rules approval_requests audit_events dsr_requests)

psql_1() { psql -h "$PGHOST" -p "$PGPORT" -U postgres -d "$PGDATABASE" -tA -c "$1" | tail -1; }

failures=()

for tbl in "${TABLES[@]}"; do
  # relrowsecurity/relforcerowsecurity live on pg_class; audit_events is a
  # partitioned table (relkind 'p'), so this must not filter by relkind.
  rls=$(psql_1 "SELECT relrowsecurity FROM pg_class WHERE relname = '$tbl';")
  force=$(psql_1 "SELECT relforcerowsecurity FROM pg_class WHERE relname = '$tbl';")
  if [ "$rls" != "t" ]; then
    failures+=("$tbl: ROW LEVEL SECURITY is not enabled (relrowsecurity=$rls)")
  fi
  if [ "$force" != "t" ]; then
    failures+=("$tbl: FORCE ROW LEVEL SECURITY is not set (relforcerowsecurity=$force) — table owner would bypass RLS")
  fi

  policy_count=$(psql_1 "SELECT count(*) FROM pg_policies WHERE tablename = '$tbl';")
  if [ "$policy_count" -lt 1 ]; then
    failures+=("$tbl: no RLS policy defined at all")
    continue
  fi

  # A single ALL-command policy with the canonical USING clause covers
  # SELECT/INSERT/UPDATE/DELETE (Postgres reuses USING as WITH CHECK when
  # no separate WITH CHECK is given for a policy with no FOR clause) — so
  # this checks that at least one policy on the table matches the exact
  # canonical pattern, applying to ALL commands, not that four separate
  # per-command policies exist.
  matching=$(psql_1 "SELECT count(*) FROM pg_policies WHERE tablename = '$tbl' AND cmd = 'ALL' AND qual = '(tenant_id = (current_setting(''app.current_tenant''::text, true))::uuid)';")
  if [ "$matching" -lt 1 ]; then
    failures+=("$tbl: no policy matches the canonical tenant_id = current_setting('app.current_tenant')::uuid pattern applied to ALL commands")
  fi

  # A row-level trigger targeting this table's tenant column with 0 rows
  # visible would silently no-op an UPDATE/DELETE — this checks the
  # migration 015 statement-level guard trigger is actually attached.
  trigger_count=$(psql_1 "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_tenant_context_guard' AND tgrelid = '$tbl'::regclass;")
  if [ "$trigger_count" -lt 1 ]; then
    failures+=("$tbl: tenant_context_violation_guard trigger (migration 015) is not attached")
  fi

  # Composite index with tenant_id as the leading column — either an
  # explicit index or an implicit one backing a UNIQUE(tenant_id, ...)
  # constraint both satisfy this; a single-column tenant_id-only index
  # does not.
  composite_count=$(psql_1 "
    SELECT count(*) FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    WHERE tc.relname = '$tbl'
      AND i.indnatts > 1
      AND (SELECT attname FROM pg_attribute WHERE attrelid = tc.oid AND attnum = i.indkey[0]) = 'tenant_id';
  ")
  if [ "$composite_count" -lt 1 ]; then
    failures+=("$tbl: no composite index with tenant_id as the leading column")
  fi
done

if [ "${#failures[@]}" -gt 0 ]; then
  echo "RLS POLICY DEFINITION FAILURE(S):"
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi

echo "PASS: all ${#TABLES[@]} tenant-scoped tables have RLS+FORCE, the canonical policy, the context-violation trigger, and a tenant_id-leading composite index."
