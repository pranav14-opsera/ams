#!/usr/bin/env bash
# WO-014 implementation step: "Run a performance baseline test with 1000
# queries across 5 tables with RLS enabled and document P50/P95 latency
# results." This is a measurement/reporting script, not a pass/fail gate —
# RLS latency is workload- and hardware-dependent, so there's no fixed
# threshold to assert against; its output is committed as a baseline
# reference (see docs/wo-014-rls-performance-baseline.md) for future
# comparison if someone suspects an RLS-related regression.
#
# Uses pgbench (bundled with this project's PostgreSQL install) rather
# than a hand-rolled loop spawning one psql process per query — pgbench's
# per-transaction --log gives real client-observed latency per query
# without a fresh process's startup cost dominating every sample.
#
# Usage: ./rls_performance_baseline.sh [host] [port] [dbname] [queries-per-table]
set -euo pipefail

PGHOST="${1:-localhost}"
PGPORT="${2:-5433}"
PGDATABASE="${3:-postgres}"
N="${4:-200}" # 200 x 5 tables = 1000 queries total

TENANT_A="11111111-1111-1111-1111-111111111111"
TABLES=(users agents audit_events abac_policies dsr_requests)

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

echo "table,queries,p50_ms,p95_ms,mean_ms"

for tbl in "${TABLES[@]}"; do
  script="$workdir/$tbl.sql"
  logprefix="$workdir/$tbl.log"
  cat > "$script" <<SQL
SET app.current_tenant = '$TENANT_A';
SELECT count(*) FROM $tbl WHERE tenant_id = '$TENANT_A';
SQL

  pgbench -h "$PGHOST" -p "$PGPORT" -U ams_app -d "$PGDATABASE" \
    -n -c 1 -t "$N" -f "$script" --log --log-prefix="$logprefix" >/dev/null

  # pgbench log columns: client_id xact_no time(us) [schedule_lag] ...
  # time is per-transaction (i.e. per full script run: SET + SELECT).
  logfile=$(ls "$logprefix".* | head -1)
  times_ms="$workdir/$tbl.times_ms"
  awk '{printf "%.3f\n", $3/1000}' "$logfile" | sort -n > "$times_ms"

  count=$(wc -l < "$times_ms")
  p50_line=$(( (count * 50 + 99) / 100 ))
  p95_line=$(( (count * 95 + 99) / 100 ))
  p50=$(sed -n "${p50_line}p" "$times_ms")
  p95=$(sed -n "${p95_line}p" "$times_ms")
  mean=$(awk '{sum+=$1} END {printf "%.3f", sum/NR}' "$times_ms")

  echo "$tbl,$count,$p50,$p95,$mean"
done
